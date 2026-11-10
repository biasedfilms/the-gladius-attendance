-- Behaviour tests for the check-in and admin API. Run with tests/sql/run.mjs.
\set ON_ERROR_STOP 1
\set QUIET 1
set client_min_messages = warning;

create schema t;
create function t.ok(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERTION FAILED: %', msg; end if;
  raise warning 'ok - %', msg;
end;
$$;
-- Runs a statement as the current role and expects it to fail with a matching message.
create function t.raises(stmt text, pattern text, msg text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlerrm ~* pattern then raise warning 'ok - %', msg; return; end if;
    raise exception 'ASSERTION FAILED: % (got error "%", expected /%/)', msg, sqlerrm, pattern;
  end;
  raise exception 'ASSERTION FAILED: % (statement succeeded)', msg;
end;
$$;
create function t.claims(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', case when uid is null then '' else json_build_object('sub', uid, 'role', 'authenticated')::text end, false);
$$;
create function t.ip(label text) returns text language sql immutable as $$ select encode(sha256(convert_to(label, 'UTF8')), 'hex') $$;
grant usage on schema t to anon, authenticated, service_role;
grant execute on all functions in schema t to anon, authenticated, service_role;

\set admin '''a0000000-0000-4000-8000-000000000001'''
\set outsider '''a0000000-0000-4000-8000-000000000002'''
\set prog_if '''b0000000-0000-4000-8000-000000000001'''
\set prog_sipil '''b0000000-0000-4000-8000-000000000002'''
\set prog_inactive '''b0000000-0000-4000-8000-000000000003'''

-- ---------------------------------------------------------------- upgrade path
select t.ok(public.normalize_attendance_name('  Budi-Santoso.  ') = 'budi santoso', 'normalisation strips punctuation and hyphens');
select t.ok(public.normalize_attendance_name('O''Neil  (Nil)') = 'oneil nil', 'normalisation strips quotes and brackets');
select t.ok((select normalized_name from public.attendance where full_name = 'Andi Wijaya.') = 'andi wijaya', 'existing rows are re-normalised');
select t.ok((select count(*) from public.attendance where full_name like 'Sari%') = 2, 'colliding legacy rows are kept, not deleted');
select t.ok((select bool_and(source = 'qr') from public.attendance), 'existing rows default to source=qr');

-- ---------------------------------------------------------------- permissions
set role anon;
select t.claims(null);
select t.raises($$select public.check_in_secure('x', 'Budi', gen_random_uuid(), repeat('a', 64))$$, 'permission denied', 'anon cannot call check_in_secure directly');
select t.raises($$select public.admin_set_meeting_status(gen_random_uuid(), 'open', 60)$$, 'permission denied', 'anon cannot call admin functions');
select t.raises($$select * from private.attendance_archive$$, 'permission denied', 'anon cannot read the archive');
select t.raises($$select * from public.check_in_attempts$$, 'permission denied', 'anon cannot read rate-limit data');
reset role;

set role authenticated;
select t.claims(:outsider);
select t.raises($$select public.admin_set_meeting_status('c0000000-0000-4000-8000-000000000001', 'open', 60)$$, 'not_authorized', 'non-admin user cannot open sessions');
select t.raises($$select public.admin_delete_attendance(gen_random_uuid())$$, 'not_authorized', 'non-admin user cannot delete attendance');
select t.raises($$select public.admin_get_qr_code('c0000000-0000-4000-8000-000000000001')$$, 'not_authorized', 'non-admin user cannot get QR codes');
select t.ok((select count(*) from public.attendance) = 0, 'non-admin user sees no attendance (RLS)');
select t.raises($$delete from public.attendance$$, 'permission denied', 'no direct DELETE on attendance');
select t.raises($$select * from private.attendance_archive$$, 'permission denied', 'authenticated cannot read the archive');
reset role;

-- ---------------------------------------------------------------- open a rotating session
set role authenticated;
select t.claims(:admin);
insert into public.meetings (id, title, meeting_date, status, created_by)
values ('c0000000-0000-4000-8000-000000000002', 'Rapat Mingguan', current_date, 'scheduled', :admin);
select t.ok((select rotating_qr from public.meetings where id = 'c0000000-0000-4000-8000-000000000002'), 'new meetings use the rotating QR by default');
select t.raises($$select public.admin_set_meeting_status('c0000000-0000-4000-8000-000000000002', 'open', 5)$$, 'invalid_duration', 'duration below 15 minutes is rejected');
select public.admin_set_meeting_status('c0000000-0000-4000-8000-000000000002', 'open', 60);
select t.ok((select status = 'open' and attendance_token ~ '^[0-9a-f]{64}$'
                    and attendance_expires_at between now() + interval '59 minutes' and now() + interval '61 minutes'
             from public.meetings where id = 'c0000000-0000-4000-8000-000000000002'), 'opening issues a token and honours the chosen duration');
select (public.admin_get_qr_code('c0000000-0000-4000-8000-000000000002')) as qr \gset
select t.ok((:'qr'::jsonb ->> 'rotating')::boolean and (:'qr'::jsonb ->> 'code') ~ '^[0-9]+\.[0-9a-f]{20}$', 'admin receives a rotating code');
select t.ok((:'qr'::jsonb ->> 'refresh_in_ms')::int between 500 and 15000, 'refresh hint is within one window');
reset role;

\set m2 '''c0000000-0000-4000-8000-000000000002'''
select :'qr'::jsonb ->> 'code' as code \gset

-- ---------------------------------------------------------------- scan → ticket
set role anon;
select t.claims(null);
select public.begin_checkin(p_meeting_id => :m2, p_code => :'code') as session \gset
select t.ok((:'session'::jsonb ->> 'valid')::boolean and (:'session'::jsonb ->> 'status') = 'open', 'fresh code starts a check-in');
select t.ok((:'session'::jsonb ->> 'ticket') ~ '^t1\.', 'a ticket is issued');
select t.ok(not (:'session'::jsonb ? 'attendance_token'), 'the meeting secret is never returned');
select t.ok((public.begin_checkin(p_meeting_id => :m2, p_code => '123.' || repeat('0', 20)) ->> 'reason') = 'invalid', 'forged code is rejected');
select t.ok((public.begin_checkin(p_meeting_id => :m2, p_code => 'garbage') ->> 'reason') = 'invalid', 'malformed code is rejected');
select t.ok((public.begin_checkin() ->> 'reason') = 'invalid', 'empty request is rejected');
reset role;
select :'session'::jsonb ->> 'ticket' as ticket \gset

-- A code shown 6 windows (90+ s) ago is expired; 5 windows ago is still fine.
select private.qr_code(id, attendance_token, private.current_qr_window() - 6) as old_code,
       private.qr_code(id, attendance_token, private.current_qr_window() - 5) as recent_code,
       attendance_token as m2_token
from public.meetings where id = :m2 \gset
set role anon;
select t.ok((public.begin_checkin(p_meeting_id => :m2, p_code => :'old_code') ->> 'reason') = 'code_expired', 'stale QR code (>90 s) is rejected as expired');
select t.ok((public.begin_checkin(p_meeting_id => :m2, p_code => :'recent_code') ->> 'valid')::boolean, 'QR code up to ~75 s old is accepted');
select t.ok((public.begin_checkin(p_token => :'m2_token') ->> 'reason') = 'rotating_required', 'static token link is refused while the QR rotates');
reset role;

-- ---------------------------------------------------------------- submit
set role service_role;
select t.ok((public.check_in_secure(:'ticket', '  Budi   Santoso ', :prog_if, t.ip('wifi')) ->> 'code') = 'recorded', 'valid ticket records attendance');
select t.ok((public.check_in_secure(:'ticket', 'budi santoso.', :prog_if, t.ip('wifi')) ->> 'code') = 'already_recorded', 'punctuation/case variant is a duplicate');
select t.ok((public.check_in_secure(:'ticket', 'Budi Santoso', :prog_sipil, t.ip('wifi')) ->> 'code') = 'recorded', 'same name in another program is a separate person');
select t.ok((public.check_in_secure(:'ticket', 'Citra', :prog_inactive, t.ip('wifi')) ->> 'code') = 'invalid_program', 'inactive program is rejected');
select t.ok((public.check_in_secure(:'ticket', '..', :prog_if, t.ip('wifi')) ->> 'code') = 'invalid_name', 'punctuation-only name is rejected');
select t.ok((public.check_in_secure('t1.nonsense', 'Citra', :prog_if, t.ip('wifi')) ->> 'code') = 'session_invalid', 'malformed ticket is rejected');
select t.ok((public.check_in_secure(regexp_replace(:'ticket', '.{4}$', '0000'), 'Citra', :prog_if, t.ip('wifi')) ->> 'code') = 'session_invalid', 'tampered ticket signature is rejected');
select t.ok((public.check_in_secure(:'ticket', 'Citra', :prog_if, 'not-a-hash') ->> 'code') = 'invalid_request', 'invalid ip hash is rejected');
reset role;
select t.ok((select full_name from public.attendance where meeting_id = :m2 and study_program_id = :prog_if) = 'Budi Santoso', 'whitespace is cleaned in the stored name');
select t.ok((select source from public.attendance where meeting_id = :m2 limit 1) = 'qr', 'scanned records have source=qr');

-- Expired ticket (issued 15+ minutes ago) with a valid signature.
select 't1.' || :m2 || '.' || (floor(extract(epoch from now())) - 901)::bigint || '.' || 'aaaaaaaaaaaaaaaa' || '.'
       || private.ticket_signature(:m2::uuid, (floor(extract(epoch from now())) - 901)::bigint, 'aaaaaaaaaaaaaaaa', :'m2_token') as old_ticket \gset
set role service_role;
select t.ok((public.check_in_secure(:'old_ticket', 'Dewi', :prog_if, t.ip('wifi')) ->> 'code') = 'ticket_expired', 'ticket older than 15 minutes is rejected');
reset role;

-- ---------------------------------------------------------------- rate limits
-- A whole class behind one campus Wi-Fi address must all be able to check in.
do $$
declare
  i integer;
  v_ticket text;
  v_code text;
  v_result text;
begin
  for i in 1..120 loop
    select private.qr_code(id, attendance_token, private.current_qr_window()) into v_code from public.meetings where id = 'c0000000-0000-4000-8000-000000000002';
    v_ticket := public.begin_checkin(p_meeting_id => 'c0000000-0000-4000-8000-000000000002', p_code => v_code) ->> 'ticket';
    v_result := public.check_in_secure(v_ticket, 'Peserta ' || i, 'b0000000-0000-4000-8000-000000000001', t.ip('campus-wifi')) ->> 'code';
    if v_result <> 'recorded' then raise exception 'ASSERTION FAILED: participant % on shared Wi-Fi got %', i, v_result; end if;
  end loop;
  raise warning 'ok - 120 participants on one shared IP all checked in';
end;
$$;

-- One ticket cannot be reused for a long list of names.
set role service_role;
select count(*) filter (where public.check_in_secure(:'ticket', 'Massal ' || g, :prog_if, t.ip('phone')) ->> 'code' = 'rate_limited') as limited
from generate_series(1, 12) g \gset
reset role;
select t.ok(:limited >= 2, 'a single ticket is capped at 10 attempts');

-- A flood from one address is stopped.
insert into public.check_in_attempts (ip_hash, attempted_at) select t.ip('flood'), now() from generate_series(1, 300);
select private.qr_code(id, attendance_token, private.current_qr_window()) as code2 from public.meetings where id = :m2 \gset
select public.begin_checkin(p_meeting_id => :m2, p_code => :'code2') ->> 'ticket' as ticket2 \gset
set role service_role;
select t.ok((public.check_in_secure(:'ticket2', 'Flood', :prog_if, t.ip('flood')) ->> 'code') = 'rate_limited', 'more than 300 attempts per 10 min from one address are rate limited');
reset role;

-- ---------------------------------------------------------------- admin session controls
set role authenticated;
select t.claims(:admin);
select public.admin_regenerate_qr(:m2);
reset role;
set role service_role;
select t.ok((public.check_in_secure(:'ticket2', 'Eka', :prog_if, t.ip('x1')) ->> 'code') = 'session_invalid', 'regenerating the QR revokes earlier tickets');
reset role;
set role anon;
select t.ok((public.begin_checkin(p_meeting_id => :m2, p_code => :'code2') ->> 'reason') = 'invalid', 'regenerating the QR revokes earlier codes');
reset role;

set role authenticated;
select t.claims(:admin);
select t.raises($$update public.meetings set title = 'hack'$$, 'permission denied', 'no direct UPDATE on meetings');
select public.admin_extend_session(:m2, 120);
select t.ok((select attendance_expires_at > now() + interval '119 minutes' from public.meetings where id = :m2), 'session can be extended');
select public.admin_set_meeting_status(:m2, 'closed');
select t.raises($$select public.admin_get_qr_code('c0000000-0000-4000-8000-000000000002')$$, 'session_not_open', 'no QR for a closed session');
select t.raises($$select public.admin_extend_session('c0000000-0000-4000-8000-000000000002', 60)$$, 'invalid_state_transition', 'closed session cannot be extended');
reset role;
select private.qr_code(id, attendance_token, private.current_qr_window()) as code3 from public.meetings where id = :m2 \gset
set role anon;
select t.ok((public.begin_checkin(p_meeting_id => :m2, p_code => :'code3') ->> 'status') = 'closed', 'scan after closing shows the closed state');
select t.ok(not (public.begin_checkin(p_meeting_id => :m2, p_code => :'code3') ? 'ticket'), 'no ticket for a closed session');
reset role;

set role authenticated;
select t.claims(:admin);
select public.admin_set_meeting_status(:m2, 'open', 30);
select t.ok((select status = 'open' and attendance_closed_at is null from public.meetings where id = :m2), 'closed session can be re-opened');
select t.ok((select attendance_token <> :'m2_token' from public.meetings where id = :m2), 're-opening issues a new secret');

-- Static link mode for online meetings.
select public.admin_update_meeting(:m2, 'Rapat Mingguan (online)', current_date, '19:00', 'Zoom', false);
select (public.admin_get_qr_code(:m2)) as qr_static \gset
select t.ok(not (:'qr_static'::jsonb ->> 'rotating')::boolean and (:'qr_static'::jsonb ->> 'token') ~ '^[0-9a-f]{64}$', 'static mode returns the shareable token');
reset role;
set role anon;
select t.ok((public.begin_checkin(p_token => :'qr_static'::jsonb ->> 'token') ->> 'ticket') ~ '^t1\.', 'static link starts a check-in');
reset role;

-- ---------------------------------------------------------------- manual add / delete / restore
set role authenticated;
select t.claims(:admin);
select public.admin_add_attendance(:m2, 'Fajar  Nugroho', :prog_sipil) as added \gset
select t.ok((select source = 'manual' and recorded_by = :admin::uuid from public.attendance where id = (:'added'::jsonb ->> 'id')::uuid), 'manual record is marked and attributed');
select t.raises($$select public.admin_add_attendance('c0000000-0000-4000-8000-000000000002', 'fajar nugroho.', 'b0000000-0000-4000-8000-000000000002')$$, 'already_recorded', 'manual duplicate is rejected');
select t.raises($$select public.admin_add_attendance('c0000000-0000-4000-8000-000000000002', 'X', 'b0000000-0000-4000-8000-000000000002')$$, 'invalid_name', 'manual add validates the name');

select public.admin_delete_attendance((:'added'::jsonb ->> 'id')::uuid) as deleted \gset
select t.ok(not exists (select 1 from public.attendance where id = (:'added'::jsonb ->> 'id')::uuid), 'deleted record is gone');
reset role;
select t.ok((select archive_reason = 'deleted' and archived_by = :admin::uuid from private.attendance_archive where archive_id = (:'deleted'::jsonb ->> 'archive_id')::uuid), 'deleted record is archived with the admin id');
set role authenticated;
select t.claims(:admin);
select public.admin_restore_attendance((:'deleted'::jsonb ->> 'archive_id')::uuid);
select t.ok(exists (select 1 from public.attendance where id = (:'added'::jsonb ->> 'id')::uuid), 'undo restores the record with its original id');
select t.raises(format('select public.admin_restore_attendance(%L)', :'deleted'::jsonb ->> 'archive_id'), 'archive_not_found', 'a record cannot be restored twice');

-- Closed meeting: admins may still add late participants.
select public.admin_set_meeting_status(:m2, 'closed');
select t.ok((public.admin_add_attendance(:m2, 'Gita', :prog_if) ->> 'ok')::boolean, 'manual add works after closing');

select count(*) as m2_count from public.attendance where meeting_id = :m2 \gset
select public.admin_delete_meeting(:m2) as meeting_deleted \gset
select t.ok((:'meeting_deleted'::jsonb ->> 'archived_attendance')::int = :m2_count, 'deleting a meeting archives all its attendance');
select t.ok(not exists (select 1 from public.meetings where id = :m2), 'meeting is deleted');
reset role;
select t.ok((select count(*) from private.attendance_archive where meeting_id = :m2 and archive_reason = 'meeting_deleted') = :m2_count, 'archived rows are kept');
select t.ok(exists (select 1 from public.meetings where id = 'c0000000-0000-4000-8000-000000000001'), 'other meetings are untouched');

select 'ALL SQL TESTS PASSED' as result;
