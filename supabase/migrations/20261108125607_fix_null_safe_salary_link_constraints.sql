-- Ensure salary link checks are strictly enforced when allocation_status is NULL.
-- In SQL 3-valued logic, `salary_record_id is not null or allocation_status = 'needs_review'`
-- evaluates to UNKNOWN (NULL) when salary_record_id is NULL and allocation_status is NULL,
-- which PostgreSQL CHECK constraints treat as passing.
-- Using `coalesce(allocation_status, '') = 'needs_review'` guarantees the condition evaluates
-- to FALSE when neither condition is satisfied.

alter table public.expenses
  drop constraint expenses_payment_source_salary_link;

alter table public.expenses
  add constraint expenses_payment_source_salary_link check (
    (payment_source = 'salary' and (salary_record_id is not null or coalesce(allocation_status, '') = 'needs_review'))
    or (payment_source in ('savings', 'others') and salary_record_id is null)
  );

alter table public.extra_income
  drop constraint extra_income_salary_review_state;

alter table public.extra_income
  add constraint extra_income_salary_review_state check (
    salary_record_id is not null or coalesce(allocation_status, '') = 'needs_review'
  );

alter table public.savings_transactions
  drop constraint savings_type_relationships;

alter table public.savings_transactions
  add constraint savings_type_relationships check (
    (transaction_type = 'contribution'
      and (source_type is null or source_type = 'salary')
      and (salary_record_id is not null or coalesce(allocation_status, '') = 'needs_review')
      and expense_id is null)
    or (transaction_type = 'external_contribution'
      and source_type is not null and source_type in ('gift', 'bonus', 'other')
      and salary_record_id is null and expense_id is null)
    or (transaction_type = 'salary_balance_transfer'
      and source_type is null
      and (salary_record_id is not null or coalesce(allocation_status, '') = 'needs_review')
      and expense_id is null)
    or (transaction_type = 'withdrawal'
      and source_type is null and salary_record_id is null and expense_id is not null)
  );
