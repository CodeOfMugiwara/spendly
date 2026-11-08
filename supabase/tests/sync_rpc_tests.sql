-- Spendly Phase 6.1: Comprehensive Sync RPC & Database Integration Tests
-- All synthetic test data rolls back at the end of execution.
-- Run against spendly-dev only.

begin;

-- Create synthetic test users in auth.users
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'sync-user-a@example.invalid', '', now(), '{}'::jsonb, '{"name":"Sync User A"}'::jsonb, now(), now()),
  ('c2000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'sync-user-b@example.invalid', '', now(), '{}'::jsonb, '{"name":"Sync User B"}'::jsonb, now(), now());

-- ============================================================================
-- 1. Anonymous Access Rejection
-- ============================================================================
set local role anon;

do $$
begin
  begin
    perform public.apply_sync_operation('{"operationId":"00000000-0000-4000-8000-000000000001"}'::jsonb);
    raise exception 'Anonymous user unexpectedly executed apply_sync_operation';
  exception when insufficient_privilege then null;
  end;

  begin
    perform public.get_sync_changes(0, 10);
    raise exception 'Anonymous user unexpectedly executed get_sync_changes';
  exception when insufficient_privilege then null;
  end;

  begin
    perform count(*) from public.sync_operations;
    raise exception 'Anonymous user unexpectedly queried sync_operations table directly';
  exception when insufficient_privilege then null;
  end;

  begin
    perform count(*) from public.sync_change_feed;
    raise exception 'Anonymous user unexpectedly queried sync_change_feed table directly';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- ============================================================================
-- 2. Authenticated Operations for User A
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c1000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

do $$
declare
  v_res jsonb;
  v_changes jsonb;
  v_salary_id uuid := 'c1000000-0000-4000-8000-000000000010';
  v_expense_id uuid := 'c1000000-0000-4000-8000-000000000020';
  v_income_id uuid := 'c1000000-0000-4000-8000-000000000030';
  v_saving_id uuid := 'c1000000-0000-4000-8000-000000000040';
  v_transfer_id uuid := 'c1000000-0000-4000-8000-000000000050';
  v_sav_exp_id uuid := 'c1000000-0000-4000-8000-000000000060';
  v_with_id uuid := 'c1000000-0000-4000-8000-000000000061';
  v_ext_saving_id uuid := 'c1000000-0000-4000-8000-000000000070';
begin
  -- 2.1 Salary Create
  v_res := public.apply_sync_operation(jsonb_build_object(
    'operationId', '11111111-0000-4000-8000-000000000001',
    'operationType', 'salary:create',
    'entityType', 'salary',
    'entityId', v_salary_id,
    'payload', jsonb_build_object(
      'salary', jsonb_build_object(
        'id', v_salary_id,
        'monthKey', '2026-01',
        'amount', 50000,
        'notes', 'Initial Jan Salary'
      )
    )
  ));
  if (v_res ->> 'status') <> 'applied' then
    raise exception 'Failed salary:create: %', v_res;
  end if;

  -- 2.2 Idempotent Replay Verification (Same payload must return skipped receipt)
  v_res := public.apply_sync_operation(jsonb_build_object(
    'operationId', '11111111-0000-4000-8000-000000000001',
    'operationType', 'salary:create',
    'entityType', 'salary',
    'entityId', v_salary_id,
    'payload', jsonb_build_object(
      'salary', jsonb_build_object(
        'id', v_salary_id,
        'monthKey', '2026-01',
        'amount', 50000,
        'notes', 'Initial Jan Salary'
      )
    )
  ));
  if (v_res ->> 'status') <> 'skipped' then
    raise exception 'Expected idempotent status skipped, got: %', v_res;
  end if;

  -- 2.3 Reusing operation ID with altered payload must be strictly rejected
  begin
    perform public.apply_sync_operation(jsonb_build_object(
      'operationId', '11111111-0000-4000-8000-000000000001',
      'operationType', 'salary:create',
      'entityType', 'salary',
      'entityId', v_salary_id,
      'payload', jsonb_build_object(
        'salary', jsonb_build_object(
          'id', v_salary_id,
          'monthKey', '2026-01',
          'amount', 99999,
          'notes', 'Altered amount!'
        )
      )
    ));
    raise exception 'Reusing operation ID with altered payload was unexpectedly accepted';
  exception when unique_violation then null;
  end;

  -- 2.4 Salary Update
  v_res := public.apply_sync_operation(jsonb_build_object(
    'operationId', '11111111-0000-4000-8000-000000000002',
    'operationType', 'salary:update',
    'entityType', 'salary',
    'entityId', v_salary_id,
    'payload', jsonb_build_object(
      'salary', jsonb_build_object('id', v_salary_id, 'amount', 55000, 'notes', 'Updated Jan Salary')
    )
  ));
  if (v_res ->> 'status') <> 'applied' then raise exception 'Failed salary:update'; end if;

  -- 2.5 Extra Income Create
  v_res := public.apply_sync_operation(jsonb_build_object(
    'operationId', '11111111-0000-4000-8000-000000000003',
    'operationType', 'extra_income:create',
    'entityType', 'extra_income',
    'entityId', v_income_id,
    'payload', jsonb_build_object(
      'extraIncome', jsonb_build_object(
        'id', v_income_id,
        'salaryRecordId', v_salary_id,
        'amount', 10000,
        'date', '2026-01-10',
        'source', 'bonus',
        'description', 'Q4 Bonus'
      )
    )
  ));
  if (v_res ->> 'status') <> 'applied' then raise exception 'Failed extra_income:create'; end if;

  -- 2.6 Savings Contribution with Extra Income Funding Allocation
  v_res := public.apply_sync_operation(jsonb_build_object(
    'operationId', '11111111-0000-4000-8000-000000000004',
    'operationType', 'savings:contribution',
    'entityType', 'saving',
    'entityId', v_saving_id,
    'payload', jsonb_build_object(
      'saving', jsonb_build_object(
        'id', v_saving_id,
        'amount', 8000,
        'date', '2026-01-12',
        'salaryRecordId', v_salary_id,
        'salaryAllocationPaise', 300000, -- 3000 rupees from regular salary
        'extraIncomeAllocations', jsonb_build_array(
          jsonb_build_object('extraIncomeRecordId', v_income_id, 'amountPaise', 500000) -- 5000 rupees from bonus
        )
      )
    )
  ));
  if (v_res ->> 'status') <> 'applied' then raise exception 'Failed savings:contribution'; end if;

  -- Verify funding allocation row exists in public.savings_funding_allocations
  if not exists (select 1 from public.savings_funding_allocations where user_id = 'c1000000-0000-4000-8000-000000000001' and savings_transaction_id = v_saving_id and extra_income_id = v_income_id and amount_paise = 500000) then
    raise exception 'Savings funding allocation row was not created properly';
  end if;

  -- 2.7 External Contribution (gift)
  v_res := public.apply_sync_operation(jsonb_build_object(
    'operationId', '11111111-0000-4000-8000-000000000005',
    'operationType', 'savings:external_contribution',
    'entityType', 'saving',
    'entityId', v_ext_saving_id,
    'payload', jsonb_build_object(
      'saving', jsonb_build_object(
        'id', v_ext_saving_id,
        'amount', 2000,
        'date', '2026-01-15',
        'sourceType', 'gift',
        'description', 'Birthday Gift'
      )
    )
  ));
  if (v_res ->> 'status') <> 'applied' then raise exception 'Failed savings:external_contribution'; end if;

  -- 2.8 Expense Create (Salary-Funded)
  v_res := public.apply_sync_operation(jsonb_build_object(
    'operationId', '11111111-0000-4000-8000-000000000006',
    'operationType', 'expense:create',
    'entityType', 'expense',
    'entityId', v_expense_id,
    'payload', jsonb_build_object(
      'expense', jsonb_build_object(
        'id', v_expense_id,
        'amount', 1500,
        'description', 'Groceries',
        'date', '2026-01-16',
        'paymentSource', 'salary',
        'salaryRecordId', v_salary_id
      )
    )
  ));
  if (v_res ->> 'status') <> 'applied' then raise exception 'Failed expense:create'; end if;

  -- 2.9 Composite Operation: Savings-Funded Expense + Linked Withdrawal
  -- Total savings currently available = 8000 + 2000 = 10,000 rupees
  v_res := public.apply_sync_operation(jsonb_build_object(
    'operationId', '11111111-0000-4000-8000-000000000007',
    'operationType', 'expense:create',
    'entityType', 'expense',
    'entityId', v_sav_exp_id,
    'payload', jsonb_build_object(
      'expense', jsonb_build_object(
        'id', v_sav_exp_id,
        'amount', 4000,
        'description', 'New Camera Lens',
        'date', '2026-01-18',
        'paymentSource', 'savings'
      ),
      'linkedWithdrawal', jsonb_build_object(
        'id', v_with_id,
        'amount', 4000,
        'date', '2026-01-18',
        'description', 'New Camera Lens'
      )
    )
  ));
  if (v_res ->> 'status') <> 'applied' then raise exception 'Failed composite expense:create'; end if;

  -- Verify linked withdrawal exists in public.savings_transactions
  if not exists (select 1 from public.savings_transactions where user_id = 'c1000000-0000-4000-8000-000000000001' and id = v_with_id and expense_id = v_sav_exp_id and transaction_type = 'withdrawal') then
    raise exception 'Linked withdrawal record was not created';
  end if;

  -- 2.10 Overdraft Prevention Test
  -- Current savings balance = 10,000 - 4,000 = 6,000 rupees.
  -- Attempting a 7,000 withdrawal must cause a check failure and rollback!
  begin
    perform public.apply_sync_operation(jsonb_build_object(
      'operationId', '11111111-0000-4000-8000-000000000099',
      'operationType', 'expense:create',
      'entityType', 'expense',
      'entityId', 'c1000000-0000-4000-8000-000000000098',
      'payload', jsonb_build_object(
        'expense', jsonb_build_object('id', 'c1000000-0000-4000-8000-000000000098', 'amount', 7000, 'description', 'Overdraft attempt', 'date', '2026-01-20', 'paymentSource', 'savings'),
        'linkedWithdrawal', jsonb_build_object('id', 'c1000000-0000-4000-8000-000000000097', 'amount', 7000, 'date', '2026-01-20')
      )
    ));
    raise exception 'Overdraft was unexpectedly permitted';
  exception when check_violation then null;
  end;

  -- 2.11 Reversal Dependency Validation
  -- Extra income has 5,000 allocated to active savings. Reversing it must fail!
  begin
    perform public.apply_sync_operation(jsonb_build_object(
      'operationId', '11111111-0000-4000-8000-000000000008',
      'operationType', 'extra_income:reverse',
      'entityType', 'extra_income',
      'entityId', v_income_id,
      'payload', jsonb_build_object('extraIncomeId', v_income_id, 'reversalId', 'rev_inc_1', 'reversedAt', now())
    ));
    raise exception 'Reversing allocated extra income was unexpectedly permitted';
  exception when check_violation then null;
  end;

  -- 2.12 Expense Deletion (Atomic with linked withdrawal)
  v_res := public.apply_sync_operation(jsonb_build_object(
    'operationId', '11111111-0000-4000-8000-000000000009',
    'operationType', 'expense:delete',
    'entityType', 'expense',
    'entityId', v_sav_exp_id,
    'payload', jsonb_build_object('expenseId', v_sav_exp_id)
  ));
  if (v_res ->> 'status') <> 'applied' then raise exception 'Failed expense:delete'; end if;

  -- Linked withdrawal must be removed/deleted
  if exists (select 1 from public.savings_transactions where user_id = 'c1000000-0000-4000-8000-000000000001' and id = v_with_id and expense_id = v_sav_exp_id and deleted_at is null) then
    raise exception 'Linked withdrawal was not deleted when expense was deleted';
  end if;

  -- 2.13 Change Feed Query & Pagination
  v_changes := public.get_sync_changes(0, 3);
  if jsonb_array_length(v_changes -> 'changes') <> 3 then
    raise exception 'Expected 3 changes in first page, got: %', v_changes;
  end if;
  if (v_changes ->> 'hasMore')::boolean <> true then
    raise exception 'Expected hasMore = true';
  end if;

  -- Next page
  v_changes := public.get_sync_changes((v_changes ->> 'nextCursor')::bigint, 10);
  if jsonb_array_length(v_changes -> 'changes') < 1 then
    raise exception 'Expected remaining changes in second page';
  end if;
end;
$$;

-- ============================================================================
-- 3. Cross-User Isolation Verification (User B cannot see or touch User A data)
-- ============================================================================
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"c2000000-0000-4000-8000-000000000002","role":"authenticated"}', true);

do $$
declare
  v_changes jsonb;
  v_res jsonb;
begin
  -- User B should see 0 operations in sync_operations
  if (select count(*) from public.sync_operations) <> 0 then
    raise exception 'User B unexpectedly sees User A sync_operations receipts';
  end if;

  -- User B should see 0 changes in sync_change_feed
  if (select count(*) from public.sync_change_feed) <> 0 then
    raise exception 'User B unexpectedly sees User A sync_change_feed entries';
  end if;

  v_changes := public.get_sync_changes(0, 100);
  if jsonb_array_length(v_changes -> 'changes') <> 0 then
    raise exception 'User B get_sync_changes returned User A changes!';
  end if;

  -- User B cannot delete User A's salary record
  begin
    perform public.apply_sync_operation(jsonb_build_object(
      'operationId', '22222222-0000-4000-8000-000000000001',
      'operationType', 'salary:delete',
      'entityType', 'salary',
      'entityId', 'c1000000-0000-4000-8000-000000000010',
      'payload', jsonb_build_object('salaryId', 'c1000000-0000-4000-8000-000000000010')
    ));
    raise exception 'User B was unexpectedly able to delete User A salary';
  exception when no_data_found then null;
  end;
end;
$$;

rollback;
