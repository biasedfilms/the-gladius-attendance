-- The Gladius 26 Attendance — initial Supabase schema
-- Apply through Supabase SQL Editor or `supabase db push` after linking your project.

create schema if not exists private;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  role text not null check (role in ('admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.study_programs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 100),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint study_programs_name_unique unique (name)
);

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  meeting_date date not null,
  start_time time,
  notes text check (notes is null or char_length(notes) <= 1000),
  status text not null default 'scheduled' check (status in ('scheduled', 'open', 'closed')),
  attendance_token text unique,
  attendance_opened_at timestamptz,
  attendance_expires_at timestamptz,
  attendance_closed_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint scheduled_meeting_has_no_token check (status <> 'scheduled' or attendance_token is null),
  constraint open_meeting_has_token check (status <> 'open' or attendance_token is not null),
  constraint open_meeting_has_expiry check (status <> 'open' or attendance_expires_at is not null)
);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete restrict,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 100),
  normalized_name text not null check (char_length(normalized_name) between 2 and 100),
  study_program_id uuid not null references public.study_programs(id) on delete restrict,
  study_program_name text not null,
  checked_in_at timestamptz not null default clock_timestamp(),
  constraint attendance_one_name_program_per_meeting unique (meeting_id, normalized_name, study_program_id)
);

create index if not exists meetings_date_created_idx on public.meetings (meeting_date desc, created_at desc);
create index if not exists attendance_meeting_time_idx on public.attendance (meeting_id, checked_in_at desc);
create index if not exists attendance_name_idx on public.attendance (normalized_name);
create index if not exists attendance_program_idx on public.attendance (study_program_id);

-- The rate-limit table stores hashes only; raw IP addresses are never persisted.
create table if not exists public.check_in_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  attempted_at timestamptz not null default clock_timestamp()
);
create index if not exists check_in_attempts_ip_time_idx on public.check_in_attempts (ip_hash, attempted_at desc);

create or replace function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'admin'
  );
$$;

create or replace function public.normalize_attendance_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(lower(btrim(coalesce(p_name, ''))), '\s+', ' ', 'g');
$$;

alter table public.profiles enable row level security;
alter table public.study_programs enable row level security;
alter table public.meetings enable row level security;
alter table public.attendance enable row level security;
alter table public.check_in_attempts enable row level security;

-- Restrictive defaults. Only an authenticated administrator can read admin data.
drop policy if exists profiles_read_self_or_admin on public.profiles;
create policy profiles_read_self_or_admin on public.profiles for select to authenticated using (id = (select auth.uid()) or private.is_admin());

drop policy if exists programs_admin_select on public.study_programs;
create policy programs_admin_select on public.study_programs for select to authenticated using (private.is_admin());
drop policy if exists programs_admin_insert on public.study_programs;
create policy programs_admin_insert on public.study_programs for insert to authenticated with check (private.is_admin());
drop policy if exists programs_admin_update on public.study_programs;
create policy programs_admin_update on public.study_programs for update to authenticated using (private.is_admin()) with check (private.is_admin());
-- Intentionally no delete policy: historical attendance references must remain valid.

drop policy if exists meetings_admin_select on public.meetings;
create policy meetings_admin_select on public.meetings for select to authenticated using (private.is_admin());
drop policy if exists meetings_admin_insert on public.meetings;
create policy meetings_admin_insert on public.meetings for insert to authenticated with check (
  private.is_admin() and created_by = (select auth.uid()) and status = 'scheduled' and attendance_token is null
);
-- Intentionally no direct UPDATE or DELETE policy. Session state changes go through the validated RPC below.

drop policy if exists attendance_admin_select on public.attendance;
create policy attendance_admin_select on public.attendance for select to authenticated using (private.is_admin());
-- No direct INSERT/UPDATE/DELETE policy for anon or authenticated clients.
-- check_in_secure is callable only by service_role through the Edge Function.

revoke all on public.profiles, public.study_programs, public.meetings, public.attendance, public.check_in_attempts from anon, authenticated;
grant select on public.profiles to authenticated;
grant select, insert, update on public.study_programs to authenticated;
grant select, insert on public.meetings to authenticated;
grant select on public.attendance to authenticated;

revoke all on function private.is_admin() from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.is_admin() to authenticated;
revoke all on function public.normalize_attendance_name(text) from public, anon, authenticated;

create or replace function public.get_active_study_programs()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.name from public.study_programs p where p.is_active = true order by p.name;
$$;
revoke all on function public.get_active_study_programs() from public;
grant execute on function public.get_active_study_programs() to anon, authenticated;

create or replace function public.get_checkin_session(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_meeting public.meetings%rowtype;
begin
  if p_token is null or length(p_token) < 32 or length(p_token) > 160 then
    return jsonb_build_object('valid', false);
  end if;
  select * into v_meeting from public.meetings m where m.attendance_token = p_token limit 1;
  if not found then return jsonb_build_object('valid', false); end if;
  return jsonb_build_object(
    'valid', true,
    'id', v_meeting.id,
    'title', v_meeting.title,
    'meeting_date', v_meeting.meeting_date,
    'start_time', v_meeting.start_time,
    'status', case when v_meeting.status = 'open' and v_meeting.attendance_expires_at <= now() then 'expired' else v_meeting.status end
  );
end;
$$;
revoke all on function public.get_checkin_session(text) from public;
grant execute on function public.get_checkin_session(text) to anon, authenticated;

create or replace function public.admin_update_meeting(
  p_meeting_id uuid,
  p_title text,
  p_meeting_date date,
  p_start_time time,
  p_notes text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then raise exception 'not_authorized'; end if;
  if length(btrim(coalesce(p_title, ''))) < 3 or length(btrim(p_title)) > 120 then raise exception 'invalid_title'; end if;
  update public.meetings set title = btrim(p_title), meeting_date = p_meeting_date, start_time = p_start_time, notes = nullif(btrim(coalesce(p_notes, '')), '')
  where id = p_meeting_id and status in ('scheduled', 'open');
  if not found then raise exception 'meeting_not_editable'; end if;
end;
$$;
revoke all on function public.admin_update_meeting(uuid,text,date,time,text) from public, anon;
grant execute on function public.admin_update_meeting(uuid,text,date,time,text) to authenticated;

create or replace function public.admin_set_meeting_status(p_meeting_id uuid, p_new_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting public.meetings%rowtype;
  v_token text;
begin
  if not private.is_admin() then raise exception 'not_authorized'; end if;
  if p_new_status is null or p_new_status not in ('open', 'closed') then raise exception 'invalid_status'; end if;
  select * into v_meeting from public.meetings where id = p_meeting_id for update;
  if not found then raise exception 'meeting_not_found'; end if;
  if p_new_status = 'open' then
    if v_meeting.status <> 'scheduled' then raise exception 'invalid_state_transition'; end if;
    v_token := replace(pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text || pg_catalog.gen_random_uuid()::text, '-', '');
    update public.meetings set status = 'open', attendance_token = v_token, attendance_opened_at = clock_timestamp(), attendance_expires_at = clock_timestamp() + interval '12 hours', attendance_closed_at = null where id = p_meeting_id;
  else
    if v_meeting.status <> 'open' then raise exception 'invalid_state_transition'; end if;
    update public.meetings set status = 'closed', attendance_closed_at = clock_timestamp() where id = p_meeting_id;
  end if;
  return jsonb_build_object('ok', true, 'status', p_new_status);
end;
$$;
revoke all on function public.admin_set_meeting_status(uuid,text) from public, anon;
grant execute on function public.admin_set_meeting_status(uuid,text) to authenticated;

create or replace function public.check_in_secure(
  p_token text,
  p_full_name text,
  p_study_program_id uuid,
  p_ip_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting public.meetings%rowtype;
  v_program public.study_programs%rowtype;
  v_normalized text;
  v_count integer;
  v_existing public.attendance%rowtype;
  v_saved public.attendance%rowtype;
begin
  -- Edge Function derives p_ip_hash from a request address using a server-only pepper.
  if p_ip_hash is null or length(p_ip_hash) <> 64 then return jsonb_build_object('ok', false, 'code', 'invalid_request'); end if;
  insert into public.check_in_attempts (ip_hash, attempted_at) values (p_ip_hash, clock_timestamp());
  delete from public.check_in_attempts where attempted_at < clock_timestamp() - interval '2 hours';
  select count(*) into v_count from public.check_in_attempts where ip_hash = p_ip_hash and attempted_at >= clock_timestamp() - interval '10 minutes';
  if v_count > 30 then return jsonb_build_object('ok', false, 'code', 'rate_limited'); end if;

  if p_token is null or length(p_token) < 32 or length(p_token) > 160 then return jsonb_build_object('ok', false, 'code', 'session_invalid'); end if;
  select * into v_meeting from public.meetings m where m.attendance_token = p_token limit 1;
  if not found then return jsonb_build_object('ok', false, 'code', 'session_invalid'); end if;
  if v_meeting.status = 'closed' then return jsonb_build_object('ok', false, 'code', 'session_closed'); end if;
  if v_meeting.status <> 'open' then return jsonb_build_object('ok', false, 'code', 'session_not_open'); end if;
  if v_meeting.attendance_expires_at is null or v_meeting.attendance_expires_at <= clock_timestamp() then return jsonb_build_object('ok', false, 'code', 'session_expired'); end if;

  if p_full_name is null or length(btrim(p_full_name)) < 2 or length(btrim(p_full_name)) > 100 then return jsonb_build_object('ok', false, 'code', 'invalid_name'); end if;
  v_normalized := public.normalize_attendance_name(p_full_name);
  select * into v_program from public.study_programs p where p.id = p_study_program_id and p.is_active = true;
  if not found then return jsonb_build_object('ok', false, 'code', 'invalid_program'); end if;

  select * into v_existing from public.attendance a
  where a.meeting_id = v_meeting.id and a.normalized_name = v_normalized and a.study_program_id = v_program.id limit 1;
  if found then
    return jsonb_build_object('ok', false, 'code', 'already_recorded');
  end if;

  begin
    insert into public.attendance (meeting_id, full_name, normalized_name, study_program_id, study_program_name, checked_in_at)
    values (v_meeting.id, btrim(regexp_replace(p_full_name, '\s+', ' ', 'g')), v_normalized, v_program.id, v_program.name, clock_timestamp())
    returning * into v_saved;
  exception when unique_violation then
    select * into v_existing from public.attendance a where a.meeting_id = v_meeting.id and a.normalized_name = v_normalized and a.study_program_id = v_program.id limit 1;
    return jsonb_build_object('ok', false, 'code', 'already_recorded');
  end;
  return jsonb_build_object('ok', true, 'code', 'recorded', 'checked_in_at', v_saved.checked_in_at);
end;
$$;
revoke all on function public.check_in_secure(text,text,uuid,text) from public, anon, authenticated;
grant execute on function public.check_in_secure(text,text,uuid,text) to service_role;

-- Enable trusted admin clients to receive updates when core records change. RLS still applies to subscribers.
do $$
begin
  if exists (select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime') then
    begin execute 'alter publication supabase_realtime add table public.attendance'; exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.meetings'; exception when duplicate_object then null; end;
    begin execute 'alter publication supabase_realtime add table public.study_programs'; exception when duplicate_object then null; end;
  end if;
end;
$$;

-- Keep privileges explicit for objects created by this migration.
revoke all on public.check_in_attempts from public, anon, authenticated;
revoke all on public.attendance from anon;
