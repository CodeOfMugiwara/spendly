-- Validate cross-row paise allocations at transaction boundaries. Constraint
-- triggers allow a savings row and its allocation rows to be written atomically.

create or replace function private.assert_savings_funding_split(p_user_id uuid, p_savings_transaction_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  saving_row public.savings_transactions%rowtype;
  allocated_extra_paise bigint;
begin
  select * into saving_row
  from public.savings_transactions s
  where s.user_id = p_user_id and s.id = p_savings_transaction_id;
  if not found then return; end if;

  select coalesce(sum(a.amount_paise), 0)::bigint into allocated_extra_paise
  from public.savings_funding_allocations a
  where a.user_id = saving_row.user_id and a.savings_transaction_id = saving_row.id;

  if saving_row.transaction_type in ('contribution', 'salary_balance_transfer') then
    if saving_row.allocation_status is distinct from 'needs_review' and
       (saving_row.salary_allocation_paise is null or
        saving_row.salary_allocation_paise + allocated_extra_paise <> saving_row.amount_paise) then
      raise exception using errcode = '23514', message = 'Savings funding allocations must equal the transaction amount in paise';
    end if;
  elsif allocated_extra_paise <> 0 or saving_row.salary_allocation_paise is not null then
    raise exception using errcode = '23514', message = 'Only salary-funded savings transactions may contain funding allocations';
  end if;
end;
$$;
revoke all on function private.assert_savings_funding_split(uuid, uuid) from public, anon, authenticated;

create or replace function private.check_savings_funding_split_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'savings_transactions' then
    if tg_op <> 'INSERT' then
      perform private.assert_savings_funding_split(old.user_id, old.id);
    end if;
    if tg_op <> 'DELETE' then
      perform private.assert_savings_funding_split(new.user_id, new.id);
    end if;
  else
    if tg_op <> 'INSERT' then
      perform private.assert_savings_funding_split(old.user_id, old.savings_transaction_id);
    end if;
    if tg_op <> 'DELETE' then
      perform private.assert_savings_funding_split(new.user_id, new.savings_transaction_id);
    end if;
  end if;
  return null;
end;
$$;
revoke all on function private.check_savings_funding_split_trigger() from public, anon, authenticated;
create constraint trigger savings_funding_split_integrity_from_transactions
  after insert or update or delete on public.savings_transactions
  deferrable initially deferred
  for each row execute function private.check_savings_funding_split_trigger();
create constraint trigger savings_funding_split_integrity_from_allocations
  after insert or update or delete on public.savings_funding_allocations
  deferrable initially deferred
  for each row execute function private.check_savings_funding_split_trigger();

create or replace function private.assert_extra_income_allocation_limit(p_user_id uuid, p_extra_income_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  income_paise bigint;
  allocated_paise bigint;
begin
  select i.amount_paise into income_paise
  from public.extra_income i
  where i.user_id = p_user_id and i.id = p_extra_income_id;
  if not found then return; end if;

  select coalesce(sum(a.amount_paise), 0)::bigint into allocated_paise
  from public.savings_funding_allocations a
  join public.savings_transactions s
    on s.user_id = a.user_id and s.id = a.savings_transaction_id
  where a.user_id = p_user_id and a.extra_income_id = p_extra_income_id
    and s.reversed_at is null and s.deleted_at is null;

  if allocated_paise > income_paise then
    raise exception using errcode = '23514', message = 'Active savings allocations exceed the linked extra-income amount';
  end if;
end;
$$;
revoke all on function private.assert_extra_income_allocation_limit(uuid, uuid) from public, anon, authenticated;

create or replace function private.check_extra_income_allocation_limit_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  allocation_row record;
begin
  if tg_table_name = 'extra_income' then
    if tg_op <> 'INSERT' then
      perform private.assert_extra_income_allocation_limit(old.user_id, old.id);
    end if;
    if tg_op <> 'DELETE' then
      perform private.assert_extra_income_allocation_limit(new.user_id, new.id);
    end if;
  elsif tg_table_name = 'savings_funding_allocations' then
    if tg_op <> 'INSERT' then
      perform private.assert_extra_income_allocation_limit(old.user_id, old.extra_income_id);
    end if;
    if tg_op <> 'DELETE' then
      perform private.assert_extra_income_allocation_limit(new.user_id, new.extra_income_id);
    end if;
  else
    if tg_op <> 'INSERT' then
      for allocation_row in
        select a.extra_income_id from public.savings_funding_allocations a
        where a.user_id = old.user_id and a.savings_transaction_id = old.id
      loop
        perform private.assert_extra_income_allocation_limit(old.user_id, allocation_row.extra_income_id);
      end loop;
    end if;
    if tg_op <> 'DELETE' then
      for allocation_row in
        select a.extra_income_id from public.savings_funding_allocations a
        where a.user_id = new.user_id and a.savings_transaction_id = new.id
      loop
        perform private.assert_extra_income_allocation_limit(new.user_id, allocation_row.extra_income_id);
      end loop;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function private.check_extra_income_allocation_limit_trigger() from public, anon, authenticated;
create constraint trigger extra_income_allocation_limit_from_income
  after insert or update or delete on public.extra_income
  deferrable initially deferred
  for each row execute function private.check_extra_income_allocation_limit_trigger();
create constraint trigger extra_income_allocation_limit_from_allocations
  after insert or update or delete on public.savings_funding_allocations
  deferrable initially deferred
  for each row execute function private.check_extra_income_allocation_limit_trigger();
create constraint trigger extra_income_allocation_limit_from_savings
  after insert or update or delete on public.savings_transactions
  deferrable initially deferred
  for each row execute function private.check_extra_income_allocation_limit_trigger();
