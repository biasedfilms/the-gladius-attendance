-- The Gladius 26 Attendance — rotating QR, ticket-based check-in, admin tools.
--
-- Upgrades a database that already has 202610220001_init.sql applied. Existing
-- meetings, attendance and study programs are preserved.
--
-- IMPORTANT: apply this together with the matching Edge Function and frontend
-- (see docs/DEPLOY.md). Between applying this file and deploying the new
-- `check-in` Edge Function, student check-in is unavailable. Do it outside a meeting.
--
-- The Supabase SQL Editor and `supabase db push` both run this file atomically:
-- if any statement fails, nothing is changed.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Schema changes
-- ---------------------------------------------------------------------------

-- Rotating QR: the QR shown in the admin dashboard changes every 15 seconds, so a
-- photographed/forwarded link stops working quickly. Admins can switch a meeting to
-- a static, shareable link (e.g. for an online meeting).
alter table public.meetings add column if not exists rotating_qr boolean not null default true;

-- How a record was created: scanned by the participant, or added by an admin.
alter table public.attendance add column if not exists source text not null default 'qr';
alter table public.attendance drop constraint if exists attendance_source_check;
alter table public.attendance add constraint attendance_source_check check (source in ('qr', 'manual'));
alter table public.attendance add column if not exists recorded_by uuid references public.profiles(id) on delete set null;

-- Rate limiting is now per check-in ticket (one ticket per QR scan) plus a generous
-- per-network cap, so a whole class on one campus Wi-Fi is never blocked.
alter table public.check_in_attempts add column if not exists ticket_nonce text;
alter table public.check_in_attempts add column if not exists meeting_id uuid;
create index if not exists check_in_attempts_ticket_idx on public.check_in_attempts (ticket_nonce) where ticket_nonce is not null;
create index if not exists check_in_attempts_time_idx on public.check_in_attempts (attempted_at);

-- Deleted attendance is archived (never exposed through the API) so an admin can
-- undo a deletion, and records remain recoverable from the SQL Editor.
create table if not exists private.attendance_archive (
  archive_id uuid primary key default gen_random_uuid(),
  attendance_id uuid not null,
  meeting_id uuid not null,
  meeting_title text,
  meeting_date date,
  full_name text not null,
  normalized_name text not null,
  study_program_id uuid not null,
  study_program_name text not null,
  checked_in_at timestamptz not null,
  source text not null,
  recorded_by uuid,
  archive_reason text not null check (archive_reason in ('deleted', 'meeting_deleted')),
  archived_by uuid,
  archived_at timestamptz not null default now(),
  restored_at timestamptz
);
create index if not exists attendance_archive_meeting_idx on private.attendance_archive (meeting_id);
alter table private.attendance_archive enable row level security;
revoke all on private.attendance_archive from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Name normalisation (duplicate detection)
-- ---------------------------------------------------------------------------

-- Lower-case, treat - _ / as spaces, drop common punctuation, collapse whitespace.
-- "Budi  Santoso." and "budi santoso" are the same person in the same program.
-- Keep in sync with normalizeName() in js/duplicates.js.
create or replace function public.normalize_attendance_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(coalesce(p_name, '')), '[-_/]+', ' ', 'g'),
      '[.,''’‘"“”`´()]+', '', 'g'),
    '\s+', ' ', 'g'));
$$;
revoke all on function public.normalize_attendance_name(text) from public, anon, authenticated;

-- Re-normalise existing records. A row whose new value would collide with another
-- record of the same person is left unchanged (and reported) instead of failing.
do $$
declare
  r record;
  v_new text;
begin
  for r in select id, full_name, normalized_name from public.attendance loop
    v_new := public.normalize_attendance_name(r.full_name);
    if v_new is distinct from r.normalized_name and char_length(v_new) between 2 and 100 then
      begin
        update public.attendance set normalized_name = v_new where id = r.id;
      exception when unique_violation then
        raise notice 'Attendance % kept its previous normalized name (would duplicate another record).', r.id;
      end;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Private helpers (not callable through the API)
-- ---------------------------------------------------------------------------

create or replace function private.hmac_hex(p_data text, p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.hmac(p_data, p_key, 'sha256'), 'hex');
$$;

-- QR windows are 15 seconds long. A code is accepted for up to 6 windows (≤ 90 s)
-- after it was shown, which covers opening the camera app and loading the page.
create or replace function private.current_qr_window()
returns bigint
language sql
volatile
set search_path = ''
as $$
  select floor(extract(epoch from clock_timestamp()) / 15)::bigint;
$$;

create or replace function private.qr_code(p_meeting_id uuid, p_token text, p_window bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_window::text || '.' || left(private.hmac_hex('qr:' || p_meeting_id::text || ':' || p_window::text, p_token), 20);
$$;

create or replace function private.ticket_signature(p_meeting_id uuid, p_issued bigint, p_nonce text, p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select left(private.hmac_hex('ticket:' || p_meeting_id::text || ':' || p_issued::text || ':' || p_nonce, p_token), 32);
$$;

create or replace function private.new_attendance_token()
returns text
language sql
volatile
set search_path = ''
as $$
  select encode(extensions.gen_random_bytes(32), 'hex');
$$;

create or replace function private.effective_status(p_status text, p_expires_at timestamptz)
returns text
language sql
volatile
set search_path = ''
as $$
  select case when p_status = 'open' and (p_expires_at is null or p_expires_at <= clock_timestamp()) then 'expired' else p_status end;
$$;

create or replace function private.assert_admin()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.archive_attendance(p_attendance_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_archive_id uuid;
begin
  insert into private.attendance_archive (
    attendance_id, meeting_id, meeting_title, meeting_date, full_name, normalized_name,
    study_program_id, study_program_name, checked_in_at, source, recorded_by,
    archive_reason, archived_by
  )
  select a.id, a.meeting_id, m.title, m.meeting_date, a.full_name, a.normalized_name,
         a.study_program_id, a.study_program_name, a.checked_in_at, a.source, a.recorded_by,
         p_reason, (select auth.uid())
  from public.attendance a
  join public.meetings m on m.id = a.meeting_id
  where a.id = p_attendance_id
  returning archive_id into v_archive_id;
  if v_archive_id is null then
    raise exception 'attendance_not_found';
  end if;
  delete from public.attendance where id = p_attendance_id;
  return v_archive_id;
end;
$$;

revoke all on function private.hmac_hex(text, text) from public, anon, authenticated;
revoke all on function private.current_qr_window() from public, anon, authenticated;
revoke all on function private.qr_code(uuid, text, bigint) from public, anon, authenticated;
revoke all on function private.ticket_signature(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function private.new_attendance_token() from public, anon, authenticated;
revoke all on function private.effective_status(text, timestamptz) from public, anon, authenticated;
revoke all on function private.assert_admin() from public, anon, authenticated;
revoke all on function private.archive_attendance(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Replace the old public check-in API
-- ---------------------------------------------------------------------------

drop function if exists public.get_checkin_session(text);
drop function if exists public.check_in_secure(text, text, uuid, text);
drop function if exists public.admin_set_meeting_status(uuid, text);
drop function if exists public.admin_update_meeting(uuid, text, date, time, text);

-- Called by the check-in page right after a scan. Validates the rotating QR code
-- (or a static link token) and returns a signed ticket valid for 15 minutes, which
-- the participant then uses to submit the form.
create or replace function public.begin_checkin(
  p_meeting_id uuid default null,
  p_code text default null,
  p_token text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_meeting public.meetings%rowtype;
  v_window bigint;
  v_status text;
  v_issued bigint;
  v_nonce text;
  v_result jsonb;
begin
  if p_token is not null then
    if length(p_token) < 32 or length(p_token) > 160 then
      return jsonb_build_object('valid', false, 'reason', 'invalid');
    end if;
    select * into v_meeting from public.meetings m where m.attendance_token = p_token;
    if not found then
      return jsonb_build_object('valid', false, 'reason', 'invalid');
    end if;
    if v_meeting.rotating_qr then
      -- A static link from before the admin enabled the rotating QR.
      return jsonb_build_object('valid', false, 'reason', 'rotating_required', 'title', v_meeting.title, 'meeting_date', v_meeting.meeting_date);
    end if;
  elsif p_meeting_id is not null and p_code is not null then
    if p_code !~ '^[0-9]{1,12}\.[0-9a-f]{20}$' then
      return jsonb_build_object('valid', false, 'reason', 'invalid');
    end if;
    select * into v_meeting from public.meetings m where m.id = p_meeting_id;
    if not found or v_meeting.attendance_token is null then
      return jsonb_build_object('valid', false, 'reason', 'invalid');
    end if;
    v_window := split_part(p_code, '.', 1)::bigint;
    if private.qr_code(v_meeting.id, v_meeting.attendance_token, v_window) <> p_code then
      return jsonb_build_object('valid', false, 'reason', 'invalid');
    end if;
    v_status := private.effective_status(v_meeting.status, v_meeting.attendance_expires_at);
    if v_status = 'open' and (v_window > private.current_qr_window() or v_window < private.current_qr_window() - 5) then
      return jsonb_build_object('valid', false, 'reason', 'code_expired', 'title', v_meeting.title, 'meeting_date', v_meeting.meeting_date);
    end if;
  else
    return jsonb_build_object('valid', false, 'reason', 'invalid');
  end if;

  v_status := private.effective_status(v_meeting.status, v_meeting.attendance_expires_at);
  v_result := jsonb_build_object(
    'valid', true,
    'id', v_meeting.id,
    'title', v_meeting.title,
    'meeting_date', v_meeting.meeting_date,
    'start_time', v_meeting.start_time,
    'status', v_status
  );
  if v_status = 'open' then
    v_issued := floor(extract(epoch from clock_timestamp()))::bigint;
    v_nonce := encode(extensions.gen_random_bytes(8), 'hex');
    v_result := v_result || jsonb_build_object(
      'ticket', 't1.' || v_meeting.id::text || '.' || v_issued::text || '.' || v_nonce || '.'
        || private.ticket_signature(v_meeting.id, v_issued, v_nonce, v_meeting.attendance_token),
      'ticket_expires_at', to_timestamp(v_issued + 900)
    );
  end if;
  return v_result;
end;
$$;
revoke all on function public.begin_checkin(uuid, text, text) from public;
grant execute on function public.begin_checkin(uuid, text, text) to anon, authenticated;

-- Called only by the `check-in` Edge Function (service role).
create or replace function public.check_in_secure(
  p_ticket text,
  p_full_name text,
  p_study_program_id uuid,
  p_ip_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_parts text[];
  v_meeting_id uuid;
  v_issued bigint;
  v_nonce text;
  v_sig text;
  v_now bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  v_meeting public.meetings%rowtype;
  v_program public.study_programs%rowtype;
  v_clean_name text;
  v_normalized text;
  v_count integer;
  v_saved public.attendance%rowtype;
begin
  if p_ip_hash is null or p_ip_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  if p_ticket ~ '^t1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9]{1,12}\.[0-9a-f]{16}\.[0-9a-f]{32}$' then
    v_parts := string_to_array(p_ticket, '.');
    v_meeting_id := v_parts[2]::uuid;
    v_issued := v_parts[3]::bigint;
    v_nonce := v_parts[4];
    v_sig := v_parts[5];
  end if;

  insert into public.check_in_attempts (ip_hash, ticket_nonce, meeting_id, attempted_at)
  values (p_ip_hash, v_nonce, v_meeting_id, clock_timestamp());
  if random() < 0.05 then
    delete from public.check_in_attempts where attempted_at < clock_timestamp() - interval '1 day';
  end if;

  -- Generous per-network cap: only stops floods, never a full class on one Wi-Fi.
  select count(*) into v_count from public.check_in_attempts
  where ip_hash = p_ip_hash and attempted_at >= clock_timestamp() - interval '10 minutes';
  if v_count > 300 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;

  if v_nonce is null then
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;

  -- Per-scan cap: one ticket cannot be used to submit a long list of names.
  select count(*) into v_count from public.check_in_attempts where ticket_nonce = v_nonce;
  if v_count > 10 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;

  select * into v_meeting from public.meetings m where m.id = v_meeting_id;
  if not found or v_meeting.attendance_token is null
     or private.ticket_signature(v_meeting.id, v_issued, v_nonce, v_meeting.attendance_token) <> v_sig then
    -- Also reached after an admin regenerated the QR (all earlier tickets are revoked).
    return jsonb_build_object('ok', false, 'code', 'session_invalid');
  end if;
  if v_meeting.status = 'closed' then
    return jsonb_build_object('ok', false, 'code', 'session_closed');
  end if;
  if v_meeting.status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'session_not_open');
  end if;
  if v_meeting.attendance_expires_at is null or v_meeting.attendance_expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'code', 'session_expired');
  end if;
  if v_issued > v_now + 5 or v_issued < v_now - 900 then
    return jsonb_build_object('ok', false, 'code', 'ticket_expired');
  end if;

  v_clean_name := btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
  v_normalized := public.normalize_attendance_name(v_clean_name);
  if char_length(v_clean_name) < 2 or char_length(v_clean_name) > 100 or char_length(v_normalized) < 2 then
    return jsonb_build_object('ok', false, 'code', 'invalid_name');
  end if;

  select * into v_program from public.study_programs p where p.id = p_study_program_id and p.is_active = true;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'invalid_program');
  end if;

  if exists (
    select 1 from public.attendance a
    where a.meeting_id = v_meeting.id and a.normalized_name = v_normalized and a.study_program_id = v_program.id
  ) then
    return jsonb_build_object('ok', false, 'code', 'already_recorded');
  end if;

  begin
    insert into public.attendance (meeting_id, full_name, normalized_name, study_program_id, study_program_name, checked_in_at, source)
    values (v_meeting.id, v_clean_name, v_normalized, v_program.id, v_program.name, clock_timestamp(), 'qr')
    returning * into v_saved;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'already_recorded');
  end;
  return jsonb_build_object('ok', true, 'code', 'recorded', 'checked_in_at', v_saved.checked_in_at);
end;
$$;
revoke all on function public.check_in_secure(text, text, uuid, text) from public, anon, authenticated;
grant execute on function public.check_in_secure(text, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Admin API (authenticated admins only; every function re-checks the role)
-- ---------------------------------------------------------------------------

create or replace function public.admin_update_meeting(
  p_meeting_id uuid,
  p_title text,
  p_meeting_date date,
  p_start_time time,
  p_notes text,
  p_rotating_qr boolean default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_admin();
  if char_length(btrim(coalesce(p_title, ''))) < 3 or char_length(btrim(p_title)) > 120 then
    raise exception 'invalid_title';
  end if;
  if p_meeting_date is null then
    raise exception 'invalid_date';
  end if;
  if p_notes is not null and char_length(p_notes) > 1000 then
    raise exception 'invalid_notes';
  end if;
  update public.meetings
  set title = btrim(p_title),
      meeting_date = p_meeting_date,
      start_time = p_start_time,
      notes = nullif(btrim(coalesce(p_notes, '')), ''),
      rotating_qr = coalesce(p_rotating_qr, rotating_qr)
  where id = p_meeting_id;
  if not found then
    raise exception 'meeting_not_found';
  end if;
end;
$$;

-- Open (also re-open a closed meeting) or close a session. Opening always issues a
-- new secret, so QR codes, links and tickets from an earlier session stop working.
create or replace function public.admin_set_meeting_status(
  p_meeting_id uuid,
  p_new_status text,
  p_duration_minutes integer default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting public.meetings%rowtype;
begin
  perform private.assert_admin();
  if p_new_status is null or p_new_status not in ('open', 'closed') then
    raise exception 'invalid_status';
  end if;
  select * into v_meeting from public.meetings where id = p_meeting_id for update;
  if not found then
    raise exception 'meeting_not_found';
  end if;
  if p_new_status = 'open' then
    if v_meeting.status not in ('scheduled', 'closed') then
      raise exception 'invalid_state_transition';
    end if;
    if p_duration_minutes is null or p_duration_minutes < 15 or p_duration_minutes > 1440 then
      raise exception 'invalid_duration';
    end if;
    update public.meetings
    set status = 'open',
        attendance_token = private.new_attendance_token(),
        attendance_opened_at = clock_timestamp(),
        attendance_expires_at = clock_timestamp() + make_interval(mins => p_duration_minutes),
        attendance_closed_at = null
    where id = p_meeting_id;
  else
    if v_meeting.status <> 'open' then
      raise exception 'invalid_state_transition';
    end if;
    update public.meetings set status = 'closed', attendance_closed_at = clock_timestamp() where id = p_meeting_id;
  end if;
  return jsonb_build_object('ok', true, 'status', p_new_status);
end;
$$;

-- Extend an open (or expired-but-not-closed) session: it stays open for
-- p_duration_minutes from now. Existing QR codes and tickets keep working.
create or replace function public.admin_extend_session(p_meeting_id uuid, p_duration_minutes integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expires timestamptz;
begin
  perform private.assert_admin();
  if p_duration_minutes is null or p_duration_minutes < 15 or p_duration_minutes > 1440 then
    raise exception 'invalid_duration';
  end if;
  update public.meetings
  set attendance_expires_at = clock_timestamp() + make_interval(mins => p_duration_minutes)
  where id = p_meeting_id and status = 'open'
  returning attendance_expires_at into v_expires;
  if not found then
    raise exception 'invalid_state_transition';
  end if;
  return jsonb_build_object('ok', true, 'expires_at', v_expires);
end;
$$;

-- Issue a new secret for an open session: every previously shown QR, shared link
-- and unsubmitted ticket stops working immediately.
create or replace function public.admin_regenerate_qr(p_meeting_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_admin();
  update public.meetings set attendance_token = private.new_attendance_token()
  where id = p_meeting_id and status = 'open';
  if not found then
    raise exception 'invalid_state_transition';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- The admin dashboard polls this while the QR dialog is open. Timing comes from the
-- database clock, so a wrong laptop clock cannot produce invalid codes.
create or replace function public.admin_get_qr_code(p_meeting_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_meeting public.meetings%rowtype;
  v_window bigint;
  v_now_ms bigint;
begin
  perform private.assert_admin();
  select * into v_meeting from public.meetings where id = p_meeting_id;
  if not found then
    raise exception 'meeting_not_found';
  end if;
  if private.effective_status(v_meeting.status, v_meeting.attendance_expires_at) <> 'open' or v_meeting.attendance_token is null then
    raise exception 'session_not_open';
  end if;
  if not v_meeting.rotating_qr then
    return jsonb_build_object('rotating', false, 'token', v_meeting.attendance_token, 'expires_at', v_meeting.attendance_expires_at);
  end if;
  v_window := private.current_qr_window();
  v_now_ms := floor(extract(epoch from clock_timestamp()) * 1000)::bigint;
  return jsonb_build_object(
    'rotating', true,
    'code', private.qr_code(v_meeting.id, v_meeting.attendance_token, v_window),
    'window_seconds', 15,
    'refresh_in_ms', greatest(500, (v_window + 1) * 15000 - v_now_ms),
    'expires_at', v_meeting.attendance_expires_at
  );
end;
$$;

-- Add a participant by hand (e.g. their phone is dead). Allowed in any session
-- state, including after the session was closed.
create or replace function public.admin_add_attendance(p_meeting_id uuid, p_full_name text, p_study_program_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_program public.study_programs%rowtype;
  v_clean_name text := btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
  v_normalized text;
  v_saved public.attendance%rowtype;
begin
  perform private.assert_admin();
  if not exists (select 1 from public.meetings where id = p_meeting_id) then
    raise exception 'meeting_not_found';
  end if;
  v_normalized := public.normalize_attendance_name(v_clean_name);
  if char_length(v_clean_name) < 2 or char_length(v_clean_name) > 100 or char_length(v_normalized) < 2 then
    raise exception 'invalid_name';
  end if;
  select * into v_program from public.study_programs where id = p_study_program_id;
  if not found then
    raise exception 'invalid_program';
  end if;
  begin
    insert into public.attendance (meeting_id, full_name, normalized_name, study_program_id, study_program_name, checked_in_at, source, recorded_by)
    values (p_meeting_id, v_clean_name, v_normalized, v_program.id, v_program.name, clock_timestamp(), 'manual', (select auth.uid()))
    returning * into v_saved;
  exception when unique_violation then
    raise exception 'already_recorded';
  end;
  return jsonb_build_object('ok', true, 'id', v_saved.id, 'checked_in_at', v_saved.checked_in_at);
end;
$$;

create or replace function public.admin_delete_attendance(p_attendance_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_admin();
  return jsonb_build_object('ok', true, 'archive_id', private.archive_attendance(p_attendance_id, 'deleted'));
end;
$$;

-- Undo a deletion. Fails if the meeting is gone or the person checked in again.
create or replace function public.admin_restore_attendance(p_archive_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.attendance_archive%rowtype;
begin
  perform private.assert_admin();
  select * into v_row from private.attendance_archive where archive_id = p_archive_id for update;
  if not found or v_row.restored_at is not null then
    raise exception 'archive_not_found';
  end if;
  if not exists (select 1 from public.meetings where id = v_row.meeting_id) then
    raise exception 'meeting_not_found';
  end if;
  begin
    insert into public.attendance (id, meeting_id, full_name, normalized_name, study_program_id, study_program_name, checked_in_at, source, recorded_by)
    values (v_row.attendance_id, v_row.meeting_id, v_row.full_name, v_row.normalized_name, v_row.study_program_id,
            v_row.study_program_name, v_row.checked_in_at, v_row.source, v_row.recorded_by);
  exception when unique_violation then
    raise exception 'already_recorded';
  end;
  update private.attendance_archive set restored_at = clock_timestamp() where archive_id = p_archive_id;
  return jsonb_build_object('ok', true, 'id', v_row.attendance_id);
end;
$$;

-- Delete a meeting. Its attendance is archived first (recoverable via SQL Editor).
create or replace function public.admin_delete_meeting(p_meeting_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  perform private.assert_admin();
  perform 1 from public.meetings where id = p_meeting_id for update;
  if not found then
    raise exception 'meeting_not_found';
  end if;
  for v_id in select id from public.attendance where meeting_id = p_meeting_id loop
    perform private.archive_attendance(v_id, 'meeting_deleted');
    v_count := v_count + 1;
  end loop;
  delete from public.meetings where id = p_meeting_id;
  return jsonb_build_object('ok', true, 'archived_attendance', v_count);
end;
$$;

revoke all on function public.admin_update_meeting(uuid, text, date, time, text, boolean) from public, anon;
revoke all on function public.admin_set_meeting_status(uuid, text, integer) from public, anon;
revoke all on function public.admin_extend_session(uuid, integer) from public, anon;
revoke all on function public.admin_regenerate_qr(uuid) from public, anon;
revoke all on function public.admin_get_qr_code(uuid) from public, anon;
revoke all on function public.admin_add_attendance(uuid, text, uuid) from public, anon;
revoke all on function public.admin_delete_attendance(uuid) from public, anon;
revoke all on function public.admin_restore_attendance(uuid) from public, anon;
revoke all on function public.admin_delete_meeting(uuid) from public, anon;
grant execute on function public.admin_update_meeting(uuid, text, date, time, text, boolean) to authenticated;
grant execute on function public.admin_set_meeting_status(uuid, text, integer) to authenticated;
grant execute on function public.admin_extend_session(uuid, integer) to authenticated;
grant execute on function public.admin_regenerate_qr(uuid) to authenticated;
grant execute on function public.admin_get_qr_code(uuid) to authenticated;
grant execute on function public.admin_add_attendance(uuid, text, uuid) to authenticated;
grant execute on function public.admin_delete_attendance(uuid) to authenticated;
grant execute on function public.admin_restore_attendance(uuid) to authenticated;
grant execute on function public.admin_delete_meeting(uuid) to authenticated;

-- Supabase grants new public tables/columns to API roles by default; keep the
-- rate-limit table private.
revoke all on public.check_in_attempts from public, anon, authenticated;
