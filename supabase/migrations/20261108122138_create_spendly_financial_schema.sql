-- Base Spendly financial schema. IDs are UUIDs; amount_paise is derived from the
-- canonical numeric amount so money precision cannot drift between columns.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.touch_updated_at_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  new.revision := old.revision + 1;
  return new;
end;
$$;
revoke all on function private.touch_updated_at_revision() from public, anon, authenticated;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) <= 100),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 2048),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function private.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(pg_catalog.left(coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name', ''), 100), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function private.create_profile_for_auth_user() from public, anon, authenticated;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function private.create_profile_for_auth_user();

create or replace function private.touch_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function private.touch_profile_updated_at() from public, anon, authenticated;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function private.touch_profile_updated_at();

create table public.salary_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  month_key text not null check (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  amount numeric(11,2) not null check (amount > 0),
  amount_paise bigint generated always as ((amount * 100)::bigint) stored,
  notes text not null default '' check (char_length(notes) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision bigint not null default 1 check (revision > 0),
  deleted_at timestamptz,
  unique (user_id, id)
);
create unique index salary_records_one_active_month_idx
  on public.salary_records (user_id, month_key) where deleted_at is null;
create trigger salary_records_touch_updated_at_revision
  before update on public.salary_records
  for each row execute function private.touch_updated_at_revision();

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount numeric(11,2) not null check (amount > 0),
  amount_paise bigint generated always as ((amount * 100)::bigint) stored,
  description text not null check (char_length(description) <= 100),
  transaction_date date not null,
  payment_source text not null check (payment_source in ('salary', 'savings', 'others')),
  salary_record_id uuid,
  allocation_status text check (allocation_status is null or allocation_status = 'needs_review'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision bigint not null default 1 check (revision > 0),
  deleted_at timestamptz,
  unique (user_id, id),
  constraint expenses_salary_owner_fk foreign key (user_id, salary_record_id)
    references public.salary_records (user_id, id) on delete restrict,
  constraint expenses_payment_source_salary_link check (
    (payment_source = 'salary' and (salary_record_id is not null or allocation_status = 'needs_review'))
    or (payment_source in ('savings', 'others') and salary_record_id is null)
  )
);
create index expenses_user_date_idx on public.expenses (user_id, transaction_date desc, created_at desc);
create index expenses_user_salary_idx on public.expenses (user_id, salary_record_id) where salary_record_id is not null;
create trigger expenses_touch_updated_at_revision
  before update on public.expenses
  for each row execute function private.touch_updated_at_revision();

create table public.extra_income (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  salary_record_id uuid,
  amount numeric(11,2) not null check (amount > 0),
  amount_paise bigint generated always as ((amount * 100)::bigint) stored,
  received_date date not null,
  month_key text not null check (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  source text not null check (source in ('freelancing', 'part-time', 'bonus', 'other')),
  description text not null default '' check (char_length(description) <= 100),
  allocation_status text check (allocation_status is null or allocation_status = 'needs_review'),
  reversed_at timestamptz,
  reversal_id text check (reversal_id is null or char_length(reversal_id) <= 128),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision bigint not null default 1 check (revision > 0),
  deleted_at timestamptz,
  unique (user_id, id),
  constraint extra_income_salary_owner_fk foreign key (user_id, salary_record_id)
    references public.salary_records (user_id, id) on delete restrict,
  constraint extra_income_month_matches_received_date check (month_key = pg_catalog.to_char(received_date, 'YYYY-MM')),
  constraint extra_income_salary_review_state check (salary_record_id is not null or allocation_status = 'needs_review')
);
create index extra_income_user_date_idx on public.extra_income (user_id, received_date desc, created_at desc);
create index extra_income_user_salary_idx on public.extra_income (user_id, salary_record_id) where salary_record_id is not null;
create trigger extra_income_touch_updated_at_revision
  before update on public.extra_income
  for each row execute function private.touch_updated_at_revision();

create table public.savings_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount numeric(11,2) not null check (amount > 0),
  amount_paise bigint generated always as ((amount * 100)::bigint) stored,
  transaction_date date not null,
  month_key text not null check (month_key ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  description text not null default '' check (char_length(description) <= 100),
  transaction_type text not null check (transaction_type in ('contribution', 'external_contribution', 'salary_balance_transfer', 'withdrawal')),
  source_type text check (source_type is null or source_type in ('salary', 'gift', 'bonus', 'other')),
  salary_record_id uuid,
  expense_id uuid,
  salary_allocation_paise bigint check (salary_allocation_paise is null or salary_allocation_paise >= 0),
  allocation_status text check (allocation_status is null or allocation_status = 'needs_review'),
  reversed_at timestamptz,
  reversal_id text check (reversal_id is null or char_length(reversal_id) <= 128),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision bigint not null default 1 check (revision > 0),
  deleted_at timestamptz,
  unique (user_id, id),
  constraint savings_salary_owner_fk foreign key (user_id, salary_record_id)
    references public.salary_records (user_id, id) on delete restrict,
  constraint savings_expense_owner_fk foreign key (user_id, expense_id)
    references public.expenses (user_id, id) on delete restrict,
  constraint savings_month_matches_date check (month_key = pg_catalog.to_char(transaction_date, 'YYYY-MM')),
  constraint savings_type_relationships check (
    (transaction_type = 'contribution'
      and (source_type is null or source_type = 'salary')
      and (salary_record_id is not null or allocation_status = 'needs_review')
      and expense_id is null)
    or (transaction_type = 'external_contribution'
      and source_type is not null and source_type in ('gift', 'bonus', 'other')
      and salary_record_id is null and expense_id is null)
    or (transaction_type = 'salary_balance_transfer'
      and source_type is null
      and (salary_record_id is not null or allocation_status = 'needs_review')
      and expense_id is null)
    or (transaction_type = 'withdrawal'
      and source_type is null and salary_record_id is null and expense_id is not null)
  ),
  constraint savings_salary_allocation_within_amount check (salary_allocation_paise is null or salary_allocation_paise <= amount_paise)
);
create index savings_user_date_idx on public.savings_transactions (user_id, transaction_date desc, created_at desc);
create index savings_user_salary_idx on public.savings_transactions (user_id, salary_record_id) where salary_record_id is not null;
create unique index savings_one_withdrawal_per_expense_idx
  on public.savings_transactions (user_id, expense_id)
  where transaction_type = 'withdrawal' and expense_id is not null;
create trigger savings_transactions_touch_updated_at_revision
  before update on public.savings_transactions
  for each row execute function private.touch_updated_at_revision();

create table public.savings_funding_allocations (
  user_id uuid not null references auth.users (id) on delete cascade,
  savings_transaction_id uuid not null,
  extra_income_id uuid not null,
  amount_paise bigint not null check (amount_paise >= 0),
  created_at timestamptz not null default now(),
  primary key (user_id, savings_transaction_id, extra_income_id),
  constraint savings_allocations_transaction_owner_fk foreign key (user_id, savings_transaction_id)
    references public.savings_transactions (user_id, id) on delete cascade,
  constraint savings_allocations_income_owner_fk foreign key (user_id, extra_income_id)
    references public.extra_income (user_id, id) on delete restrict
);
create index savings_funding_allocations_income_idx on public.savings_funding_allocations (user_id, extra_income_id);

-- A withdrawal must match the Savings-funded expense it represents. The
-- constraint is deferred so both related rows can be written atomically.
create or replace function private.assert_savings_withdrawal_matches_expense()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  checked_user_id uuid;
  checked_expense_id uuid;
  expense_row public.expenses%rowtype;
  withdrawal_row public.savings_transactions%rowtype;
begin
  if tg_table_name = 'expenses' then
    checked_user_id := coalesce(new.user_id, old.user_id);
    checked_expense_id := coalesce(new.id, old.id);
  else
    checked_user_id := coalesce(new.user_id, old.user_id);
    checked_expense_id := coalesce(new.expense_id, old.expense_id);
  end if;
  if checked_expense_id is null then
    return null;
  end if;

  select * into expense_row
  from public.expenses e
  where e.user_id = checked_user_id and e.id = checked_expense_id;

  select * into withdrawal_row
  from public.savings_transactions s
  where s.user_id = checked_user_id
    and s.expense_id = checked_expense_id
    and s.transaction_type = 'withdrawal'
    and s.deleted_at is null;

  if found and expense_row.id is null then
    raise exception 'Savings withdrawal must reference an existing expense';
  end if;
  if withdrawal_row.id is not null and
     (expense_row.payment_source <> 'savings' or expense_row.amount_paise <> withdrawal_row.amount_paise) then
    raise exception 'Savings withdrawal must match its linked Savings-funded expense amount';
  end if;
  if expense_row.id is not null and expense_row.payment_source = 'savings' and expense_row.deleted_at is null
     and withdrawal_row.id is null then
    raise exception 'Savings-funded expense requires one linked withdrawal';
  end if;
  return null;
end;
$$;
revoke all on function private.assert_savings_withdrawal_matches_expense() from public, anon, authenticated;
create constraint trigger savings_withdrawal_expense_integrity_from_savings
  after insert or update or delete on public.savings_transactions
  deferrable initially deferred
  for each row execute function private.assert_savings_withdrawal_matches_expense();
create constraint trigger savings_withdrawal_expense_integrity_from_expenses
  after insert or update or delete on public.expenses
  deferrable initially deferred
  for each row execute function private.assert_savings_withdrawal_matches_expense();
