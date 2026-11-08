-- Isolate every profile and financial row to its owning authenticated user.

revoke all on table public.profiles, public.salary_records, public.expenses,
  public.extra_income, public.savings_transactions, public.savings_funding_allocations
  from public, anon, authenticated;

grant select, insert, update, delete on table public.profiles,
  public.salary_records, public.expenses, public.extra_income,
  public.savings_transactions, public.savings_funding_allocations
  to authenticated;

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.salary_records enable row level security;
alter table public.salary_records force row level security;
alter table public.expenses enable row level security;
alter table public.expenses force row level security;
alter table public.extra_income enable row level security;
alter table public.extra_income force row level security;
alter table public.savings_transactions enable row level security;
alter table public.savings_transactions force row level security;
alter table public.savings_funding_allocations enable row level security;
alter table public.savings_funding_allocations force row level security;

create policy profiles_select_own on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_insert_own on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy profiles_delete_own on public.profiles for delete to authenticated using (id = (select auth.uid()));

create policy salary_records_select_own on public.salary_records for select to authenticated using (user_id = (select auth.uid()));
create policy salary_records_insert_own on public.salary_records for insert to authenticated with check (user_id = (select auth.uid()));
create policy salary_records_update_own on public.salary_records for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy salary_records_delete_own on public.salary_records for delete to authenticated using (user_id = (select auth.uid()));

create policy expenses_select_own on public.expenses for select to authenticated using (user_id = (select auth.uid()));
create policy expenses_insert_own on public.expenses for insert to authenticated with check (user_id = (select auth.uid()));
create policy expenses_update_own on public.expenses for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy expenses_delete_own on public.expenses for delete to authenticated using (user_id = (select auth.uid()));

create policy extra_income_select_own on public.extra_income for select to authenticated using (user_id = (select auth.uid()));
create policy extra_income_insert_own on public.extra_income for insert to authenticated with check (user_id = (select auth.uid()));
create policy extra_income_update_own on public.extra_income for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy extra_income_delete_own on public.extra_income for delete to authenticated using (user_id = (select auth.uid()));

create policy savings_transactions_select_own on public.savings_transactions for select to authenticated using (user_id = (select auth.uid()));
create policy savings_transactions_insert_own on public.savings_transactions for insert to authenticated with check (user_id = (select auth.uid()));
create policy savings_transactions_update_own on public.savings_transactions for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy savings_transactions_delete_own on public.savings_transactions for delete to authenticated using (user_id = (select auth.uid()));

create policy savings_funding_allocations_select_own on public.savings_funding_allocations for select to authenticated using (user_id = (select auth.uid()));
create policy savings_funding_allocations_insert_own on public.savings_funding_allocations for insert to authenticated with check (user_id = (select auth.uid()));
create policy savings_funding_allocations_update_own on public.savings_funding_allocations for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy savings_funding_allocations_delete_own on public.savings_funding_allocations for delete to authenticated using (user_id = (select auth.uid()));
