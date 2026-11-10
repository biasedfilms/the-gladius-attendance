-- Data created with the ORIGINAL schema (before 20261110223726), so the upgrade path
-- is tested on realistic existing rows.
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'admin@example.test'),
  ('a0000000-0000-4000-8000-000000000002', 'outsider@example.test');
insert into public.profiles (id, display_name, role) values
  ('a0000000-0000-4000-8000-000000000001', 'Admin', 'admin');

insert into public.study_programs (id, name, is_active) values
  ('b0000000-0000-4000-8000-000000000001', 'Teknik Informatika', true),
  ('b0000000-0000-4000-8000-000000000002', 'Teknik Sipil', true),
  ('b0000000-0000-4000-8000-000000000003', 'Teknik Lama', false);

insert into public.meetings (id, title, meeting_date, status, attendance_token, attendance_opened_at, attendance_expires_at, attendance_closed_at, created_by)
values ('c0000000-0000-4000-8000-000000000001', 'Rapat Lama', '2026-10-28', 'closed', repeat('ab', 48),
        now() - interval '14 days', now() - interval '13 days', now() - interval '13 days',
        'a0000000-0000-4000-8000-000000000001');

-- Old normalisation kept punctuation: "Sari." and "Sari" were different people.
insert into public.attendance (meeting_id, full_name, normalized_name, study_program_id, study_program_name) values
  ('c0000000-0000-4000-8000-000000000001', 'Andi Wijaya.', public.normalize_attendance_name('Andi Wijaya.'), 'b0000000-0000-4000-8000-000000000001', 'Teknik Informatika'),
  ('c0000000-0000-4000-8000-000000000001', 'Sari', public.normalize_attendance_name('Sari'), 'b0000000-0000-4000-8000-000000000002', 'Teknik Sipil'),
  ('c0000000-0000-4000-8000-000000000001', 'Sari.', public.normalize_attendance_name('Sari.'), 'b0000000-0000-4000-8000-000000000002', 'Teknik Sipil');
