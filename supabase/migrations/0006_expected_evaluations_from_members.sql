-- ---------------------------------------------------------------------------
-- Total evaluations per candidate now always equals the number of judges
-- assigned to that candidate's panel. panels.expected_evaluations is kept as a
-- derived cache for the candidate_results view, but it is maintained from
-- panel_members and can no longer be configured manually.
-- ---------------------------------------------------------------------------

alter table public.panels
  drop constraint if exists panels_expected_evaluations_check;

alter table public.panels
  add constraint panels_expected_evaluations_check check (expected_evaluations >= 0);

alter table public.panels
  alter column expected_evaluations set default 0;

-- Always derive the count on insert/update, ignoring any supplied value.
create or replace function public.enforce_panel_expected_evaluations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.expected_evaluations := 0;
  else
    new.expected_evaluations := (
      select count(*)::int
      from public.panel_members
      where panel_id = new.id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists panels_sync_expected_evaluations on public.panels;
create trigger panels_sync_expected_evaluations
  before insert or update on public.panels
  for each row execute function public.enforce_panel_expected_evaluations();

-- Recompute the cached count whenever judge membership changes.
create or replace function public.sync_panel_expected_evaluations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    update public.panels
    set expected_evaluations = (
      select count(*)::int from public.panel_members where panel_id = old.panel_id
    )
    where id = old.panel_id;
    return null;
  end if;

  update public.panels
  set expected_evaluations = (
    select count(*)::int from public.panel_members where panel_id = new.panel_id
  )
  where id = new.panel_id;

  if tg_op = 'UPDATE' and old.panel_id is distinct from new.panel_id then
    update public.panels
    set expected_evaluations = (
      select count(*)::int from public.panel_members where panel_id = old.panel_id
    )
    where id = old.panel_id;
  end if;

  return null;
end;
$$;

drop trigger if exists panel_members_sync_expected_evaluations on public.panel_members;
create trigger panel_members_sync_expected_evaluations
  after insert or delete or update of panel_id on public.panel_members
  for each row execute function public.sync_panel_expected_evaluations();

-- Backfill existing panels from their current membership.
update public.panels
set expected_evaluations = (
  select count(*)::int from public.panel_members where panel_id = public.panels.id
);
