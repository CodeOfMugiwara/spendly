-- Hosted RLS and constraint verification.
-- All identities and financial records below are synthetic and this entire script rolls back.
-- Run against spendly-dev only.

begin;

-- Create synthetic Auth users for testing
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'rls-user-a@example.invalid', '', now(), '{}'::jsonb, '{"name":"User A"}'::jsonb, now(), now()),
  ('b2000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'rls-user-b@example.invalid', '', now(), '{}'::jsonb, '{"name":"User B"}'::jsonb, now(), now());

-- Initial records for User A and User B
insert into public.salary_records (id, user_id, month_key, amount, notes) values
  ('a1000000-0000-4000-8000-000000000011', 'a1000000-0000-4000-8000-000000000001', '2026-01', 50000, 'User A Salary'),
  ('b2000000-0000-4000-8000-000000000022', 'b2000000-0000-4000-8000-000000000002', '2026-01', 60000, 'User B Salary');

insert into public.expenses (id, user_id, amount, description, transaction_date, payment_source, salary_record_id) values
  ('a1000000-0000-4000-8000-000000000012', 'a1000000-0000-4000-8000-000000000001', 100, 'User A expense', '2026-01-02', 'salary', 'a1000000-0000-4000-8000-000000000011'),
  ('b2000000-0000-4000-8000-000000000023', 'b2000000-0000-4000-8000-000000000002', 200, 'User B expense', '2026-01-03', 'salary', 'b2000000-0000-4000-8000-000000000022');

insert into public.extra_income (id, user_id, salary_record_id, amount, received_date, month_key, source, description) values
  ('a1000000-0000-4000-8000-000000000014', 'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000011', 1000, '2026-01-04', '2026-01', 'bonus', 'User A income'),
  ('b2000000-0000-4000-8000-000000000024', 'b2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000022', 500, '2026-01-04', '2026-01', 'bonus', 'User B income');

insert into public.savings_transactions (id, user_id, amount, transaction_date, month_key, description, transaction_type, source_type, salary_record_id, salary_allocation_paise)
values
  ('a1000000-0000-4000-8000-000000000013', 'a1000000-0000-4000-8000-000000000001', 500, '2026-01-05', '2026-01', 'User A savings', 'contribution', 'salary', 'a1000000-0000-4000-8000-000000000011', 40000),
  ('b2000000-0000-4000-8000-000000000025', 'b2000000-0000-4000-8000-000000000002', 200, '2026-01-05', '2026-01', 'User B savings', 'contribution', 'salary', 'b2000000-0000-4000-8000-000000000022', 20000);

insert into public.savings_funding_allocations (user_id, savings_transaction_id, extra_income_id, amount_paise)
values
  ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000013', 'a1000000-0000-4000-8000-000000000014', 10000),
  ('b2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000025', 'b2000000-0000-4000-8000-000000000024', 0);

-- ============================================================================
-- 1. Anonymous users have no table grants and direct queries are rejected
-- ============================================================================
do $$
declare
  guarded_table text;
begin
  foreach guarded_table in array array['profiles', 'salary_records', 'expenses', 'extra_income', 'savings_transactions', 'savings_funding_allocations'] loop
    if has_table_privilege('anon', format('public.%I', guarded_table), 'select') then
      raise exception 'anon unexpectedly has SELECT on %', guarded_table;
    end if;
    if exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = guarded_table and 'anon' = any(roles)) then
      raise exception 'anon unexpectedly has an applicable policy on %', guarded_table;
    end if;
  end loop;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform count(*) from public.salary_records;
    raise exception 'Anonymous user unexpectedly queried salary_records';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.expenses;
    raise exception 'Anonymous user unexpectedly queried expenses';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- ============================================================================
-- 2. Authenticated User A can access their own records, and CANNOT see User B
-- ============================================================================
set local role authenticated;
select pg_catalog.set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $$
declare
  visible_count integer;
  deleted_count integer;
begin
  -- User A should see exactly 1 profile (their own)
  select count(*) into visible_count from public.profiles;
  if visible_count <> 1 then raise exception 'User A profile count expected 1, got %', visible_count; end if;

  -- User A should see exactly 1 salary record (their own)
  select count(*) into visible_count from public.salary_records;
  if visible_count <> 1 then raise exception 'User A salary count expected 1, got %', visible_count; end if;

  -- User A should see exactly 1 expense (their own)
  select count(*) into visible_count from public.expenses;
  if visible_count <> 1 then raise exception 'User A expenses count expected 1, got %', visible_count; end if;

  -- User A should see exactly 1 extra income record (their own)
  select count(*) into visible_count from public.extra_income;
  if visible_count <> 1 then raise exception 'User A extra income count expected 1, got %', visible_count; end if;

  -- User A should see exactly 1 savings transaction (their own)
  select count(*) into visible_count from public.savings_transactions;
  if visible_count <> 1 then raise exception 'User A savings count expected 1, got %', visible_count; end if;

  -- User A should see exactly 1 savings funding allocation (their own)
  select count(*) into visible_count from public.savings_funding_allocations;
  if visible_count <> 1 then raise exception 'User A allocations count expected 1, got %', visible_count; end if;

  -- ============================================================================
  -- 3. User A cannot delete records owned by User B (0 rows affected)
  -- ============================================================================
  delete from public.salary_records where id = 'b2000000-0000-4000-8000-000000000022';
  get diagnostics deleted_count = row_count;
  if deleted_count <> 0 then raise exception 'User A unexpectedly deleted User B salary record'; end if;

  delete from public.expenses where id = 'b2000000-0000-4000-8000-000000000023';
  get diagnostics deleted_count = row_count;
  if deleted_count <> 0 then raise exception 'User A unexpectedly deleted User B expense'; end if;

  -- ============================================================================
  -- 4. User A cannot insert records owned by User B
  -- ============================================================================
  begin
    insert into public.profiles (id, display_name)
    values ('b2000000-0000-4000-8000-000000000002', 'cross-owner profile');
    raise exception 'User A unexpectedly inserted a profile owned by User B';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.salary_records (user_id, month_key, amount)
    values ('b2000000-0000-4000-8000-000000000002', '2026-02', 50000);
    raise exception 'User A unexpectedly inserted a salary owned by User B';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.expenses (user_id, amount, description, transaction_date, payment_source, salary_record_id)
    values ('b2000000-0000-4000-8000-000000000002', 1, 'cross-owner expense insert', '2026-01-06', 'salary', 'b2000000-0000-4000-8000-000000000022');
    raise exception 'User A unexpectedly inserted an expense owned by User B';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.extra_income (user_id, salary_record_id, amount, received_date, month_key, source)
    values ('b2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000022', 100, '2026-01-06', '2026-01', 'bonus');
    raise exception 'User A unexpectedly inserted extra income owned by User B';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.savings_transactions (user_id, amount, transaction_date, month_key, transaction_type, source_type, salary_record_id, salary_allocation_paise)
    values ('b2000000-0000-4000-8000-000000000002', 10, '2026-01-06', '2026-01', 'contribution', 'salary', 'b2000000-0000-4000-8000-000000000022', 1000);
    raise exception 'User A unexpectedly inserted savings owned by User B';
  exception when insufficient_privilege then null;
  end;

  -- ============================================================================
  -- 5. User A cannot update existing records to transfer ownership to User B
  -- ============================================================================
  begin
    update public.profiles set id = 'b2000000-0000-4000-8000-000000000002'
      where id = 'a1000000-0000-4000-8000-000000000001';
    raise exception 'User A unexpectedly changed profile owner';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.salary_records set user_id = 'b2000000-0000-4000-8000-000000000002'
      where id = 'a1000000-0000-4000-8000-000000000011';
    raise exception 'User A unexpectedly changed salary owner';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.expenses set user_id = 'b2000000-0000-4000-8000-000000000002'
      where id = 'a1000000-0000-4000-8000-000000000012';
    raise exception 'User A unexpectedly changed expense owner';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.extra_income set user_id = 'b2000000-0000-4000-8000-000000000002'
      where id = 'a1000000-0000-4000-8000-000000000014';
    raise exception 'User A unexpectedly changed extra income owner';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.savings_transactions set user_id = 'b2000000-0000-4000-8000-000000000002'
      where id = 'a1000000-0000-4000-8000-000000000013';
    raise exception 'User A unexpectedly changed savings owner';
  exception when insufficient_privilege then null;
  end;

  -- ============================================================================
  -- 6. Foreign keys prevent cross-user links (ownership-aware composite FKs)
  -- ============================================================================
  -- Expense referencing User B salary record
  begin
    insert into public.expenses (user_id, amount, description, transaction_date, payment_source, salary_record_id)
    values ('a1000000-0000-4000-8000-000000000001', 1, 'cross-user salary link', '2026-01-06', 'salary', 'b2000000-0000-4000-8000-000000000022');
    raise exception 'A cross-user salary reference was accepted on expenses';
  exception when foreign_key_violation then null;
  end;

  -- Extra income referencing User B salary record
  begin
    insert into public.extra_income (user_id, salary_record_id, amount, received_date, month_key, source)
    values ('a1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000022', 10, '2026-01-06', '2026-01', 'bonus');
    raise exception 'A cross-user salary reference was accepted on extra_income';
  exception when foreign_key_violation then null;
  end;

  -- Savings transaction referencing User B salary record
  begin
    insert into public.savings_transactions (user_id, amount, transaction_date, month_key, transaction_type, source_type, salary_record_id, salary_allocation_paise)
    values ('a1000000-0000-4000-8000-000000000001', 10, '2026-01-06', '2026-01', 'contribution', 'salary', 'b2000000-0000-4000-8000-000000000022', 1000);
    raise exception 'A cross-user salary reference was accepted on savings_transactions';
  exception when foreign_key_violation then null;
  end;

  -- Savings transaction referencing User B expense for withdrawal
  begin
    insert into public.savings_transactions (user_id, amount, transaction_date, month_key, transaction_type, expense_id)
    values ('a1000000-0000-4000-8000-000000000001', 200, '2026-01-06', '2026-01', 'withdrawal', 'b2000000-0000-4000-8000-000000000023');
    raise exception 'A cross-user expense reference was accepted on savings_transactions';
  exception when foreign_key_violation then null;
  end;

  -- Savings funding allocation referencing User B extra income
  begin
    insert into public.savings_funding_allocations (user_id, savings_transaction_id, extra_income_id, amount_paise)
    values ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000013', 'b2000000-0000-4000-8000-000000000024', 100);
    raise exception 'A cross-user savings funding allocation (income) was accepted';
  exception when foreign_key_violation then null;
  end;

  -- Savings funding allocation referencing User B savings transaction
  begin
    insert into public.savings_funding_allocations (user_id, savings_transaction_id, extra_income_id, amount_paise)
    values ('a1000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000025', 'a1000000-0000-4000-8000-000000000014', 100);
    raise exception 'A cross-user savings funding allocation (transaction) was accepted';
  exception when foreign_key_violation then null;
  end;

  -- ============================================================================
  -- 7. Business constraints: One salary per user per month, Payment source rules
  -- ============================================================================
  -- Duplicate salary month for same user rejected
  begin
    insert into public.salary_records (user_id, month_key, amount)
    values ('a1000000-0000-4000-8000-000000000001', '2026-01', 40000);
    raise exception 'Duplicate salary month for same user was accepted';
  exception when unique_violation then null;
  end;

  -- Expense with payment_source = 'salary' requires a salary_record_id (unless needs_review)
  begin
    insert into public.expenses (user_id, amount, description, transaction_date, payment_source, salary_record_id)
    values ('a1000000-0000-4000-8000-000000000001', 50, 'Invalid salary expense', '2026-01-07', 'salary', null);
    raise exception 'Salary expense without salary_record_id was accepted';
  exception when check_violation then null;
  end;

  -- Expense with payment_source in ('savings', 'others') must not have salary_record_id
  begin
    insert into public.expenses (user_id, amount, description, transaction_date, payment_source, salary_record_id)
    values ('a1000000-0000-4000-8000-000000000001', 50, 'Invalid others expense', '2026-01-07', 'others', 'a1000000-0000-4000-8000-000000000011');
    raise exception 'Non-salary expense with salary_record_id was accepted';
  exception when check_violation then null;
  end;

  -- Over-allocation of extra income is rejected by deferred triggers
  begin
    insert into public.savings_transactions (id, user_id, amount, transaction_date, month_key, description, transaction_type, source_type, salary_record_id, salary_allocation_paise)
    values ('a1000000-0000-4000-8000-000000000099', 'a1000000-0000-4000-8000-000000000001', 1000, '2026-01-08', '2026-01', 'overallocated savings', 'contribution', 'salary', 'a1000000-0000-4000-8000-000000000011', 0);
    insert into public.savings_funding_allocations (user_id, savings_transaction_id, extra_income_id, amount_paise)
    values ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000099', 'a1000000-0000-4000-8000-000000000014', 9999999);
    set constraints all immediate;
    raise exception 'Savings allocations exceeding the extra-income balance were accepted';
  exception when check_violation then null;
  end;
  set constraints all deferred;

end;
$$;

-- ============================================================================
-- 8. Authenticated User B verification (bidirectional isolation)
-- ============================================================================
select pg_catalog.set_config('request.jwt.claims', '{"sub":"b2000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

do $$
declare
  visible_count integer;
begin
  -- User B should see exactly 1 profile (their own)
  select count(*) into visible_count from public.profiles;
  if visible_count <> 1 then raise exception 'User B profile count expected 1, got %', visible_count; end if;

  -- User B should see exactly 1 salary record (their own)
  select count(*) into visible_count from public.salary_records;
  if visible_count <> 1 then raise exception 'User B salary count expected 1, got %', visible_count; end if;

  -- User B should see exactly 1 expense (their own)
  select count(*) into visible_count from public.expenses;
  if visible_count <> 1 then raise exception 'User B expenses count expected 1, got %', visible_count; end if;

  -- User B should see exactly 1 extra income record (their own)
  select count(*) into visible_count from public.extra_income;
  if visible_count <> 1 then raise exception 'User B extra income count expected 1, got %', visible_count; end if;

  -- User B should see exactly 1 savings transaction (their own)
  select count(*) into visible_count from public.savings_transactions;
  if visible_count <> 1 then raise exception 'User B savings count expected 1, got %', visible_count; end if;

  -- User B cannot insert records owned by User A
  begin
    insert into public.expenses (user_id, amount, description, transaction_date, payment_source, salary_record_id)
    values ('a1000000-0000-4000-8000-000000000001', 1, 'User B attacking User A', '2026-01-09', 'salary', 'a1000000-0000-4000-8000-000000000011');
    raise exception 'User B unexpectedly inserted an expense owned by User A';
  exception when insufficient_privilege then null;
  end;

  -- User B cannot update User A's expense
  update public.expenses set amount = 9999 where id = 'a1000000-0000-4000-8000-000000000012';
  if found then raise exception 'User B unexpectedly updated User A expense'; end if;
end;
$$;

rollback;
