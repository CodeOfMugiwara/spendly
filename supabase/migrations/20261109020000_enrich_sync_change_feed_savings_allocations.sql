-- Spendly Phase 6.2: Enrich sync change feed for savings allocations
-- Target: PostgreSQL 17 (Supabase spendly-dev)

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
      case
        when c.entity_type = 'saving' then
          c.record || pg_catalog.jsonb_build_object(
            'extra_income_allocations',
            coalesce(
              (
                select pg_catalog.jsonb_agg(
                  pg_catalog.jsonb_build_object(
                    'extraIncomeRecordId', a.extra_income_id,
                    'amountPaise', a.amount_paise
                  )
                )
                from public.savings_funding_allocations a
                where a.user_id = c.user_id and a.savings_transaction_id = c.entity_id
              ),
              '[]'::jsonb
            )
          )
        else c.record
      end as record,
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
