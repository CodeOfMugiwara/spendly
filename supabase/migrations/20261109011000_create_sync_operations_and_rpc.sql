-- Spendly Phase 6.1: Server-Side Sync Infrastructure, Idempotency & Atomic RPC
-- Target: PostgreSQL 17 (Supabase)

-- 1. Operation receipts and idempotency table
create table if not exists public.sync_operations (
  user_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  operation_type text not null,
  entity_type text not null,
  entity_id uuid not null,
  payload_hash text not null,
  status text not null check (status in ('applied', 'skipped', 'conflict')),
  result jsonb not null default '{}'::jsonb,
  applied_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);

alter table public.sync_operations enable row level security;
alter table public.sync_operations force row level security;

-- Restrict direct read/write: authenticated users can only view their own receipts.
-- Writes are performed exclusively by SECURITY DEFINER RPC.
drop policy if exists sync_operations_select_own on public.sync_operations;
create policy sync_operations_select_own
  on public.sync_operations for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.sync_operations from public, anon;
grant select on table public.sync_operations to authenticated;

-- 2. Incremental change feed for remote delta synchronization
create table if not exists public.sync_change_feed (
  cursor bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  operation_type text not null,
  entity_type text not null,
  entity_id uuid not null,
  action text not null check (action in ('create', 'update', 'delete', 'reverse')),
  record jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists sync_change_feed_user_cursor_idx
  on public.sync_change_feed (user_id, cursor);

alter table public.sync_change_feed enable row level security;
alter table public.sync_change_feed force row level security;

drop policy if exists sync_change_feed_select_own on public.sync_change_feed;
create policy sync_change_feed_select_own
  on public.sync_change_feed for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.sync_change_feed from public, anon;
grant select on table public.sync_change_feed to authenticated;

-- 3. Atomic financial operation RPC
create or replace function public.apply_sync_operation(p_operation jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_op_id uuid;
  v_op_type text;
  v_entity_type text;
  v_entity_id uuid;
  v_payload jsonb;
  v_payload_hash text;
  v_existing_receipt public.sync_operations%rowtype;
  v_new_cursor bigint;
  v_result jsonb;

  -- Working variables for domain mutations
  v_salary public.salary_records%rowtype;
  v_expense public.expenses%rowtype;
  v_extra_income public.extra_income%rowtype;
  v_saving public.savings_transactions%rowtype;

  -- Temporary variables for JSON parsing
  v_sub_obj jsonb;
  v_alloc_arr jsonb;
  v_alloc_item jsonb;
  v_linked_with jsonb;
  v_with_id uuid;
  v_savings_bal bigint;
  v_reversal_id text;
  v_reversed_at timestamptz;
  v_now timestamptz := pg_catalog.now();
begin
  -- Step 1: Enforce authentication
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  -- Step 2: Validate operation structure
  if p_operation is null or pg_catalog.jsonb_typeof(p_operation) <> 'object' then
    raise exception using errcode = '22023', message = 'Operation must be a non-null JSON object';
  end if;

  begin
    v_op_id := (p_operation ->> 'operationId')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'Invalid or missing UUID for operationId';
  end;

  v_op_type := p_operation ->> 'operationType';
  v_entity_type := p_operation ->> 'entityType';

  begin
    v_entity_id := (p_operation ->> 'entityId')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'Invalid or missing UUID for entityId';
  end;

  v_payload := p_operation -> 'payload';
  if v_payload is null or pg_catalog.jsonb_typeof(v_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'Operation payload must be a non-null JSON object';
  end if;

  -- Compute deterministic SHA-256 fingerprint of the payload
  v_payload_hash := pg_catalog.encode(pg_catalog.sha256(v_payload::text::bytea), 'hex');

  -- Step 3: Check idempotency
  select * into v_existing_receipt
  from public.sync_operations
  where user_id = v_user_id and operation_id = v_op_id;

  if found then
    if v_existing_receipt.payload_hash = v_payload_hash then
      -- Idempotent repeat: return the existing success receipt
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'status', 'skipped',
        'message', 'Operation already applied (idempotent)',
        'operationId', v_op_id,
        'receipt', v_existing_receipt.result
      );
    else
      -- Mismatched payload for same operation ID is strictly rejected
      raise exception using errcode = '23505',
        message = 'Operation ID already processed with different payload';
    end if;
  end if;

  -- Step 4: Map and apply the financial mutation
  case v_op_type

    /* ---------------------------------------------------------------------- */
    /* 1. Salary Operations                                                   */
    /* ---------------------------------------------------------------------- */
    when 'salary:create' then
      v_sub_obj := coalesce(v_payload -> 'salary', v_payload);
      insert into public.salary_records (
        id, user_id, month_key, amount, notes, created_at, updated_at
      ) values (
        v_entity_id,
        v_user_id,
        v_sub_obj ->> 'monthKey',
        (v_sub_obj ->> 'amount')::numeric,
        coalesce(v_sub_obj ->> 'notes', ''),
        coalesce((v_sub_obj ->> 'createdAt')::timestamptz, v_now),
        coalesce((v_sub_obj ->> 'updatedAt')::timestamptz, v_now)
      ) returning * into v_salary;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'salary', v_entity_id, 'create', pg_catalog.to_jsonb(v_salary)
      ) returning cursor into v_new_cursor;

    when 'salary:update' then
      v_sub_obj := coalesce(v_payload -> 'salary', v_payload);
      update public.salary_records set
        month_key = coalesce(v_sub_obj ->> 'monthKey', month_key),
        amount = coalesce((v_sub_obj ->> 'amount')::numeric, amount),
        notes = coalesce(v_sub_obj ->> 'notes', notes),
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id and deleted_at is null
      returning * into v_salary;

      if not found then
        raise exception using errcode = 'P0002', message = 'Salary record not found for update';
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'salary', v_entity_id, 'update', pg_catalog.to_jsonb(v_salary)
      ) returning cursor into v_new_cursor;

    when 'salary:delete' then
      -- Check if referenced by active expenses, extra income or savings
      if exists (select 1 from public.expenses where user_id = v_user_id and salary_record_id = v_entity_id and deleted_at is null) or
         exists (select 1 from public.extra_income where user_id = v_user_id and salary_record_id = v_entity_id and deleted_at is null) or
         exists (select 1 from public.savings_transactions where user_id = v_user_id and salary_record_id = v_entity_id and deleted_at is null) then
        raise exception using errcode = '23503', message = 'Cannot delete salary record referenced by active financial records';
      end if;

      update public.salary_records set
        deleted_at = v_now,
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id and deleted_at is null
      returning * into v_salary;

      if not found then
        raise exception using errcode = 'P0002', message = 'Salary record not found for deletion';
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'salary', v_entity_id, 'delete', pg_catalog.to_jsonb(v_salary)
      ) returning cursor into v_new_cursor;

    when 'salary:restore' then
      v_sub_obj := coalesce(v_payload -> 'salary', v_payload);
      -- Restore soft-deleted record or insert if missing
      update public.salary_records set
        deleted_at = null,
        month_key = coalesce(v_sub_obj ->> 'monthKey', month_key),
        amount = coalesce((v_sub_obj ->> 'amount')::numeric, amount),
        notes = coalesce(v_sub_obj ->> 'notes', notes),
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id
      returning * into v_salary;

      if not found then
        insert into public.salary_records (
          id, user_id, month_key, amount, notes, created_at, updated_at
        ) values (
          v_entity_id,
          v_user_id,
          v_sub_obj ->> 'monthKey',
          (v_sub_obj ->> 'amount')::numeric,
          coalesce(v_sub_obj ->> 'notes', ''),
          coalesce((v_sub_obj ->> 'createdAt')::timestamptz, v_now),
          v_now
        ) returning * into v_salary;
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'salary', v_entity_id, 'update', pg_catalog.to_jsonb(v_salary)
      ) returning cursor into v_new_cursor;

    /* ---------------------------------------------------------------------- */
    /* 2. Expense Operations (Regular & Composite Savings-Funded)             */
    /* ---------------------------------------------------------------------- */
    when 'expense:create' then
      v_sub_obj := coalesce(v_payload -> 'expense', v_payload);
      insert into public.expenses (
        id, user_id, amount, description, transaction_date, payment_source,
        salary_record_id, allocation_status, created_at, updated_at
      ) values (
        v_entity_id,
        v_user_id,
        (v_sub_obj ->> 'amount')::numeric,
        v_sub_obj ->> 'description',
        (v_sub_obj ->> 'date')::date,
        v_sub_obj ->> 'paymentSource',
        (v_sub_obj ->> 'salaryRecordId')::uuid,
        v_sub_obj ->> 'allocationStatus',
        coalesce((v_sub_obj ->> 'createdAt')::timestamptz, v_now),
        coalesce((v_sub_obj ->> 'updatedAt')::timestamptz, v_now)
      ) returning * into v_expense;

      -- Composite operation: if savings-funded, create linked withdrawal atomically
      v_linked_with := coalesce(v_payload -> 'linkedWithdrawal', v_payload -> 'withdrawal');
      if v_linked_with is not null and pg_catalog.jsonb_typeof(v_linked_with) = 'object' then
        v_with_id := (v_linked_with ->> 'id')::uuid;
        insert into public.savings_transactions (
          id, user_id, amount, transaction_date, month_key, description,
          transaction_type, source_type, expense_id, created_at, updated_at
        ) values (
          v_with_id,
          v_user_id,
          (v_linked_with ->> 'amount')::numeric,
          (v_linked_with ->> 'date')::date,
          coalesce(v_linked_with ->> 'monthKey', pg_catalog.to_char((v_linked_with ->> 'date')::date, 'YYYY-MM')),
          coalesce(v_linked_with ->> 'description', v_expense.description),
          'withdrawal',
          null,
          v_entity_id,
          coalesce((v_linked_with ->> 'createdAt')::timestamptz, v_expense.created_at),
          coalesce((v_linked_with ->> 'updatedAt')::timestamptz, v_expense.updated_at)
        );
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'expense', v_entity_id, 'create', pg_catalog.to_jsonb(v_expense)
      ) returning cursor into v_new_cursor;

    when 'expense:update' then
      v_sub_obj := coalesce(v_payload -> 'expense', v_payload);
      update public.expenses set
        amount = coalesce((v_sub_obj ->> 'amount')::numeric, amount),
        description = coalesce(v_sub_obj ->> 'description', description),
        transaction_date = coalesce((v_sub_obj ->> 'date')::date, transaction_date),
        payment_source = coalesce(v_sub_obj ->> 'paymentSource', payment_source),
        salary_record_id = (v_sub_obj ->> 'salaryRecordId')::uuid,
        allocation_status = v_sub_obj ->> 'allocationStatus',
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id and deleted_at is null
      returning * into v_expense;

      if not found then
        raise exception using errcode = 'P0002', message = 'Expense not found for update';
      end if;

      -- Handle transition of payment source
      v_linked_with := coalesce(v_payload -> 'linkedWithdrawal', v_payload -> 'withdrawal');
      if v_expense.payment_source = 'savings' then
        if v_linked_with is not null and pg_catalog.jsonb_typeof(v_linked_with) = 'object' then
          v_with_id := (v_linked_with ->> 'id')::uuid;
          insert into public.savings_transactions (
            id, user_id, amount, transaction_date, month_key, description,
            transaction_type, expense_id, created_at, updated_at
          ) values (
            v_with_id,
            v_user_id,
            v_expense.amount,
            v_expense.transaction_date,
            pg_catalog.to_char(v_expense.transaction_date, 'YYYY-MM'),
            v_expense.description,
            'withdrawal',
            v_entity_id,
            v_now, v_now
          )
          on conflict (user_id, id) do update set
            amount = excluded.amount,
            transaction_date = excluded.transaction_date,
            month_key = excluded.month_key,
            description = excluded.description,
            deleted_at = null,
            updated_at = v_now;
        end if;
      else
        -- If transitioned away from savings, remove any linked withdrawal
        delete from public.savings_transactions
        where user_id = v_user_id and expense_id = v_entity_id and transaction_type = 'withdrawal';
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'expense', v_entity_id, 'update', pg_catalog.to_jsonb(v_expense)
      ) returning cursor into v_new_cursor;

    when 'expense:delete' then
      update public.expenses set
        deleted_at = v_now,
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id and deleted_at is null
      returning * into v_expense;

      if not found then
        raise exception using errcode = 'P0002', message = 'Expense not found for deletion';
      end if;

      -- Soft delete or delete linked withdrawal
      delete from public.savings_transactions
      where user_id = v_user_id and expense_id = v_entity_id and transaction_type = 'withdrawal';

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'expense', v_entity_id, 'delete', pg_catalog.to_jsonb(v_expense)
      ) returning cursor into v_new_cursor;

    when 'expense:restore' then
      v_sub_obj := coalesce(v_payload -> 'expense', v_payload);
      update public.expenses set
        deleted_at = null,
        amount = coalesce((v_sub_obj ->> 'amount')::numeric, amount),
        description = coalesce(v_sub_obj ->> 'description', description),
        transaction_date = coalesce((v_sub_obj ->> 'date')::date, transaction_date),
        payment_source = coalesce(v_sub_obj ->> 'paymentSource', payment_source),
        salary_record_id = (v_sub_obj ->> 'salaryRecordId')::uuid,
        allocation_status = v_sub_obj ->> 'allocationStatus',
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id
      returning * into v_expense;

      if not found then
        insert into public.expenses (
          id, user_id, amount, description, transaction_date, payment_source,
          salary_record_id, allocation_status, created_at, updated_at
        ) values (
          v_entity_id,
          v_user_id,
          (v_sub_obj ->> 'amount')::numeric,
          v_sub_obj ->> 'description',
          (v_sub_obj ->> 'date')::date,
          v_sub_obj ->> 'paymentSource',
          (v_sub_obj ->> 'salaryRecordId')::uuid,
          v_sub_obj ->> 'allocationStatus',
          coalesce((v_sub_obj ->> 'createdAt')::timestamptz, v_now),
          v_now
        ) returning * into v_expense;
      end if;

      v_linked_with := coalesce(v_payload -> 'linkedWithdrawal', v_payload -> 'withdrawal');
      if v_expense.payment_source = 'savings' and v_linked_with is not null then
        v_with_id := (v_linked_with ->> 'id')::uuid;
        insert into public.savings_transactions (
          id, user_id, amount, transaction_date, month_key, description,
          transaction_type, expense_id, created_at, updated_at
        ) values (
          v_with_id,
          v_user_id,
          v_expense.amount,
          v_expense.transaction_date,
          pg_catalog.to_char(v_expense.transaction_date, 'YYYY-MM'),
          v_expense.description,
          'withdrawal',
          v_entity_id,
          v_now, v_now
        )
        on conflict (user_id, id) do update set
          deleted_at = null,
          amount = excluded.amount,
          updated_at = v_now;
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'expense', v_entity_id, 'update', pg_catalog.to_jsonb(v_expense)
      ) returning cursor into v_new_cursor;

    /* ---------------------------------------------------------------------- */
    /* 3. Extra Income Operations                                             */
    /* ---------------------------------------------------------------------- */
    when 'extra_income:create' then
      v_sub_obj := coalesce(v_payload -> 'extraIncome', v_payload);
      insert into public.extra_income (
        id, user_id, salary_record_id, amount, received_date, month_key,
        source, description, allocation_status, created_at, updated_at
      ) values (
        v_entity_id,
        v_user_id,
        (v_sub_obj ->> 'salaryRecordId')::uuid,
        (v_sub_obj ->> 'amount')::numeric,
        (v_sub_obj ->> 'date')::date,
        coalesce(v_sub_obj ->> 'monthKey', pg_catalog.to_char((v_sub_obj ->> 'date')::date, 'YYYY-MM')),
        coalesce(v_sub_obj ->> 'source', 'other'),
        coalesce(v_sub_obj ->> 'description', ''),
        v_sub_obj ->> 'allocationStatus',
        coalesce((v_sub_obj ->> 'createdAt')::timestamptz, v_now),
        coalesce((v_sub_obj ->> 'updatedAt')::timestamptz, v_now)
      ) returning * into v_extra_income;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'extra_income', v_entity_id, 'create', pg_catalog.to_jsonb(v_extra_income)
      ) returning cursor into v_new_cursor;

    when 'extra_income:update' then
      v_sub_obj := coalesce(v_payload -> 'extraIncome', v_payload);
      update public.extra_income set
        amount = coalesce((v_sub_obj ->> 'amount')::numeric, amount),
        received_date = coalesce((v_sub_obj ->> 'date')::date, received_date),
        month_key = coalesce(v_sub_obj ->> 'monthKey', pg_catalog.to_char(coalesce((v_sub_obj ->> 'date')::date, received_date), 'YYYY-MM')),
        source = coalesce(v_sub_obj ->> 'source', source),
        description = coalesce(v_sub_obj ->> 'description', description),
        salary_record_id = (v_sub_obj ->> 'salaryRecordId')::uuid,
        allocation_status = v_sub_obj ->> 'allocationStatus',
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id and deleted_at is null
      returning * into v_extra_income;

      if not found then
        raise exception using errcode = 'P0002', message = 'Extra income not found for update';
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'extra_income', v_entity_id, 'update', pg_catalog.to_jsonb(v_extra_income)
      ) returning cursor into v_new_cursor;

    when 'extra_income:delete' then
      if exists (select 1 from public.savings_funding_allocations where user_id = v_user_id and extra_income_id = v_entity_id) then
        raise exception using errcode = '23503', message = 'Cannot delete extra income with active savings funding allocations';
      end if;

      update public.extra_income set
        deleted_at = v_now,
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id and deleted_at is null
      returning * into v_extra_income;

      if not found then
        raise exception using errcode = 'P0002', message = 'Extra income not found for deletion';
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'extra_income', v_entity_id, 'delete', pg_catalog.to_jsonb(v_extra_income)
      ) returning cursor into v_new_cursor;

    when 'extra_income:reverse' then
      v_reversal_id := coalesce(v_payload ->> 'reversalId', v_payload -> 'reversedRecord' ->> 'reversalId');
      v_reversed_at := coalesce((v_payload ->> 'reversedAt')::timestamptz, (v_payload -> 'reversedRecord' ->> 'reversedAt')::timestamptz, v_now);

      if exists (
        select 1 from public.savings_funding_allocations a
        join public.savings_transactions s on s.user_id = a.user_id and s.id = a.savings_transaction_id
        where a.user_id = v_user_id and a.extra_income_id = v_entity_id and s.reversed_at is null and s.deleted_at is null
      ) then
        raise exception using errcode = '23514', message = 'Cannot reverse extra income with active dependent savings allocations';
      end if;

      update public.extra_income set
        reversed_at = v_reversed_at,
        reversal_id = v_reversal_id,
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id
      returning * into v_extra_income;

      if not found then
        raise exception using errcode = 'P0002', message = 'Extra income not found for reversal';
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'extra_income', v_entity_id, 'reverse', pg_catalog.to_jsonb(v_extra_income)
      ) returning cursor into v_new_cursor;

    /* ---------------------------------------------------------------------- */
    /* 4. Savings Operations (Contributions, Transfers, Reversals)            */
    /* ---------------------------------------------------------------------- */
    when 'savings:contribution' then
      v_sub_obj := coalesce(v_payload -> 'saving', v_payload);
      insert into public.savings_transactions (
        id, user_id, amount, transaction_date, month_key, description,
        transaction_type, source_type, salary_record_id, salary_allocation_paise,
        allocation_status, created_at, updated_at
      ) values (
        v_entity_id,
        v_user_id,
        (v_sub_obj ->> 'amount')::numeric,
        (v_sub_obj ->> 'date')::date,
        coalesce(v_sub_obj ->> 'monthKey', pg_catalog.to_char((v_sub_obj ->> 'date')::date, 'YYYY-MM')),
        coalesce(v_sub_obj ->> 'description', ''),
        'contribution',
        'salary',
        (v_sub_obj ->> 'salaryRecordId')::uuid,
        (v_sub_obj ->> 'salaryAllocationPaise')::bigint,
        v_sub_obj ->> 'allocationStatus',
        coalesce((v_sub_obj ->> 'createdAt')::timestamptz, v_now),
        coalesce((v_sub_obj ->> 'updatedAt')::timestamptz, v_now)
      ) returning * into v_saving;

      -- Apply funding allocations atomically
      v_alloc_arr := v_sub_obj -> 'extraIncomeAllocations';
      if v_alloc_arr is not null and pg_catalog.jsonb_typeof(v_alloc_arr) = 'array' then
        for v_alloc_item in select * from pg_catalog.jsonb_array_elements(v_alloc_arr) loop
          insert into public.savings_funding_allocations (
            user_id, savings_transaction_id, extra_income_id, amount_paise
          ) values (
            v_user_id,
            v_entity_id,
            (v_alloc_item ->> 'extraIncomeRecordId')::uuid,
            (v_alloc_item ->> 'amountPaise')::bigint
          );
        end loop;
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'saving', v_entity_id, 'create', pg_catalog.to_jsonb(v_saving)
      ) returning cursor into v_new_cursor;

    when 'savings:external_contribution' then
      v_sub_obj := coalesce(v_payload -> 'saving', v_payload);
      insert into public.savings_transactions (
        id, user_id, amount, transaction_date, month_key, description,
        transaction_type, source_type, created_at, updated_at
      ) values (
        v_entity_id,
        v_user_id,
        (v_sub_obj ->> 'amount')::numeric,
        (v_sub_obj ->> 'date')::date,
        coalesce(v_sub_obj ->> 'monthKey', pg_catalog.to_char((v_sub_obj ->> 'date')::date, 'YYYY-MM')),
        coalesce(v_sub_obj ->> 'description', ''),
        'external_contribution',
        coalesce(v_sub_obj ->> 'sourceType', 'other'),
        coalesce((v_sub_obj ->> 'createdAt')::timestamptz, v_now),
        coalesce((v_sub_obj ->> 'updatedAt')::timestamptz, v_now)
      ) returning * into v_saving;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'saving', v_entity_id, 'create', pg_catalog.to_jsonb(v_saving)
      ) returning cursor into v_new_cursor;

    when 'savings:transfer_balance' then
      v_sub_obj := coalesce(v_payload -> 'saving', v_payload);
      insert into public.savings_transactions (
        id, user_id, amount, transaction_date, month_key, description,
        transaction_type, source_type, salary_record_id, salary_allocation_paise,
        allocation_status, created_at, updated_at
      ) values (
        v_entity_id,
        v_user_id,
        (v_sub_obj ->> 'amount')::numeric,
        (v_sub_obj ->> 'date')::date,
        coalesce(v_sub_obj ->> 'monthKey', pg_catalog.to_char((v_sub_obj ->> 'date')::date, 'YYYY-MM')),
        coalesce(v_sub_obj ->> 'description', ''),
        'salary_balance_transfer',
        null,
        (v_sub_obj ->> 'salaryRecordId')::uuid,
        (v_sub_obj ->> 'salaryAllocationPaise')::bigint,
        v_sub_obj ->> 'allocationStatus',
        coalesce((v_sub_obj ->> 'createdAt')::timestamptz, v_now),
        coalesce((v_sub_obj ->> 'updatedAt')::timestamptz, v_now)
      ) returning * into v_saving;

      v_alloc_arr := v_sub_obj -> 'extraIncomeAllocations';
      if v_alloc_arr is not null and pg_catalog.jsonb_typeof(v_alloc_arr) = 'array' then
        for v_alloc_item in select * from pg_catalog.jsonb_array_elements(v_alloc_arr) loop
          insert into public.savings_funding_allocations (
            user_id, savings_transaction_id, extra_income_id, amount_paise
          ) values (
            v_user_id,
            v_entity_id,
            (v_alloc_item ->> 'extraIncomeRecordId')::uuid,
            (v_alloc_item ->> 'amountPaise')::bigint
          );
        end loop;
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'saving', v_entity_id, 'create', pg_catalog.to_jsonb(v_saving)
      ) returning cursor into v_new_cursor;

    when 'savings:update' then
      v_sub_obj := coalesce(v_payload -> 'saving', v_payload);
      update public.savings_transactions set
        amount = coalesce((v_sub_obj ->> 'amount')::numeric, amount),
        transaction_date = coalesce((v_sub_obj ->> 'date')::date, transaction_date),
        month_key = coalesce(v_sub_obj ->> 'monthKey', pg_catalog.to_char(coalesce((v_sub_obj ->> 'date')::date, transaction_date), 'YYYY-MM')),
        description = coalesce(v_sub_obj ->> 'description', description),
        source_type = coalesce(v_sub_obj ->> 'sourceType', source_type),
        salary_allocation_paise = (v_sub_obj ->> 'salaryAllocationPaise')::bigint,
        allocation_status = v_sub_obj ->> 'allocationStatus',
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id and deleted_at is null
      returning * into v_saving;

      if not found then
        raise exception using errcode = 'P0002', message = 'Savings transaction not found for update';
      end if;

      -- Replace funding allocations
      delete from public.savings_funding_allocations
      where user_id = v_user_id and savings_transaction_id = v_entity_id;

      v_alloc_arr := v_sub_obj -> 'extraIncomeAllocations';
      if v_alloc_arr is not null and pg_catalog.jsonb_typeof(v_alloc_arr) = 'array' then
        for v_alloc_item in select * from pg_catalog.jsonb_array_elements(v_alloc_arr) loop
          insert into public.savings_funding_allocations (
            user_id, savings_transaction_id, extra_income_id, amount_paise
          ) values (
            v_user_id,
            v_entity_id,
            (v_alloc_item ->> 'extraIncomeRecordId')::uuid,
            (v_alloc_item ->> 'amountPaise')::bigint
          );
        end loop;
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'saving', v_entity_id, 'update', pg_catalog.to_jsonb(v_saving)
      ) returning cursor into v_new_cursor;

    when 'savings:delete' then
      delete from public.savings_funding_allocations
      where user_id = v_user_id and savings_transaction_id = v_entity_id;

      update public.savings_transactions set
        deleted_at = v_now,
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id and deleted_at is null
      returning * into v_saving;

      if not found then
        raise exception using errcode = 'P0002', message = 'Savings transaction not found for deletion';
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'saving', v_entity_id, 'delete', pg_catalog.to_jsonb(v_saving)
      ) returning cursor into v_new_cursor;

    when 'savings:restore' then
      v_sub_obj := coalesce(v_payload -> 'saving', v_payload);
      update public.savings_transactions set
        deleted_at = null,
        amount = coalesce((v_sub_obj ->> 'amount')::numeric, amount),
        transaction_date = coalesce((v_sub_obj ->> 'date')::date, transaction_date),
        description = coalesce(v_sub_obj ->> 'description', description),
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id
      returning * into v_saving;

      if not found then
        insert into public.savings_transactions (
          id, user_id, amount, transaction_date, month_key, description,
          transaction_type, source_type, salary_record_id, salary_allocation_paise,
          allocation_status, created_at, updated_at
        ) values (
          v_entity_id,
          v_user_id,
          (v_sub_obj ->> 'amount')::numeric,
          (v_sub_obj ->> 'date')::date,
          coalesce(v_sub_obj ->> 'monthKey', pg_catalog.to_char((v_sub_obj ->> 'date')::date, 'YYYY-MM')),
          coalesce(v_sub_obj ->> 'description', ''),
          coalesce(v_sub_obj ->> 'type', 'contribution'),
          v_sub_obj ->> 'sourceType',
          (v_sub_obj ->> 'salaryRecordId')::uuid,
          (v_sub_obj ->> 'salaryAllocationPaise')::bigint,
          v_sub_obj ->> 'allocationStatus',
          coalesce((v_sub_obj ->> 'createdAt')::timestamptz, v_now),
          v_now
        ) returning * into v_saving;
      end if;

      delete from public.savings_funding_allocations
      where user_id = v_user_id and savings_transaction_id = v_entity_id;

      v_alloc_arr := v_sub_obj -> 'extraIncomeAllocations';
      if v_alloc_arr is not null and pg_catalog.jsonb_typeof(v_alloc_arr) = 'array' then
        for v_alloc_item in select * from pg_catalog.jsonb_array_elements(v_alloc_arr) loop
          insert into public.savings_funding_allocations (
            user_id, savings_transaction_id, extra_income_id, amount_paise
          ) values (
            v_user_id,
            v_entity_id,
            (v_alloc_item ->> 'extraIncomeRecordId')::uuid,
            (v_alloc_item ->> 'amountPaise')::bigint
          );
        end loop;
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'saving', v_entity_id, 'update', pg_catalog.to_jsonb(v_saving)
      ) returning cursor into v_new_cursor;

    when 'savings:reverse' then
      v_reversal_id := coalesce(v_payload ->> 'reversalId', v_payload -> 'reversedRecord' ->> 'reversalId');
      v_reversed_at := coalesce((v_payload ->> 'reversedAt')::timestamptz, (v_payload -> 'reversedRecord' ->> 'reversedAt')::timestamptz, v_now);

      update public.savings_transactions set
        reversed_at = v_reversed_at,
        reversal_id = v_reversal_id,
        updated_at = v_now
      where user_id = v_user_id and id = v_entity_id and reversed_at is null
      returning * into v_saving;

      if not found then
        raise exception using errcode = 'P0002', message = 'Active savings transaction not found for reversal';
      end if;

      insert into public.sync_change_feed (
        user_id, operation_id, operation_type, entity_type, entity_id, action, record
      ) values (
        v_user_id, v_op_id, v_op_type, 'saving', v_entity_id, 'reverse', pg_catalog.to_jsonb(v_saving)
      ) returning cursor into v_new_cursor;

    else
      raise exception using errcode = '22023', message = 'Unsupported operation type: ' || coalesce(v_op_type, '<null>');
  end case;

  -- Step 5: Recalculate savings balance to ensure no overdraft occurred
  select coalesce(sum(
    case
      when transaction_type = 'withdrawal' then -amount_paise
      else amount_paise
    end
  ), 0)::bigint into v_savings_bal
  from public.savings_transactions
  where user_id = v_user_id and reversed_at is null and deleted_at is null;

  if v_savings_bal < 0 then
    raise exception using errcode = '23514',
      message = 'Operation would cause a savings overdraft: balance in paise is ' || v_savings_bal;
  end if;

  -- Step 6: Record idempotency receipt
  v_result := pg_catalog.jsonb_build_object(
    'ok', true,
    'status', 'applied',
    'operationId', v_op_id,
    'operationType', v_op_type,
    'entityType', v_entity_type,
    'entityId', v_entity_id,
    'cursor', v_new_cursor,
    'serverTime', v_now
  );

  insert into public.sync_operations (
    user_id, operation_id, operation_type, entity_type, entity_id,
    payload_hash, status, result, applied_at
  ) values (
    v_user_id, v_op_id, v_op_type, v_entity_type, v_entity_id,
    v_payload_hash, 'applied', v_result, v_now
  );

  return v_result;
end;
$$;

revoke all on function public.apply_sync_operation(jsonb) from public, anon;
grant execute on function public.apply_sync_operation(jsonb) to authenticated;

-- 4. Incremental change feed query RPC
create or replace function public.get_sync_changes(
  p_after_cursor bigint default 0,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_limit integer;
  v_changes jsonb;
  v_next_cursor bigint := coalesce(p_after_cursor, 0);
  v_has_more boolean := false;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  v_limit := least(greatest(coalesce(p_limit, 100), 1), 500);

  with change_batch as (
    select
      c.cursor,
      c.operation_id as "operationId",
      c.operation_type as "operationType",
      c.entity_type as "entityType",
      c.entity_id as "entityId",
      c.action,
      c.record,
      c.created_at as "createdAt"
    from public.sync_change_feed c
    where c.user_id = v_user_id and c.cursor > coalesce(p_after_cursor, 0)
    order by c.cursor asc
    limit v_limit + 1
  ),
  counted as (
    select *, (row_number() over ()) as row_num from change_batch
  )
  select
    coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'cursor', cursor,
        'operationId', "operationId",
        'operationType', "operationType",
        'entityType', "entityType",
        'entityId', "entityId",
        'action', action,
        'record', record,
        'createdAt', "createdAt"
      )
    ) filter (where row_num <= v_limit), '[]'::jsonb),
    coalesce(max(cursor) filter (where row_num <= v_limit), coalesce(p_after_cursor, 0)),
    bool_or(row_num > v_limit)
  into v_changes, v_next_cursor, v_has_more
  from counted;

  return pg_catalog.jsonb_build_object(
    'changes', v_changes,
    'nextCursor', v_next_cursor,
    'hasMore', coalesce(v_has_more, false)
  );
end;
$$;

revoke all on function public.get_sync_changes(bigint, integer) from public, anon;
grant execute on function public.get_sync_changes(bigint, integer) to authenticated;
