# Panduan Deploy & Operasional

Dokumen ini untuk pengelola teknis. Panduan penggunaan untuk admin dan peserta ada di [README](../README.md).

## Arsitektur singkat

| Bagian | Lokasi | Keterangan |
|---|---|---|
| Situs statis | Vercel (root repo, tanpa build) | `index.html`, `login.html`, `admin.html`, `check-in.html`, `js/`, `css/`. Library (`supabase-js`, `qrcodejs`) disimpan di `js/vendor/`, bukan CDN. |
| Database | Supabase Postgres | Skema di `supabase/migrations/`. Semua perubahan data lewat fungsi SQL yang memeriksa peran admin; RLS aktif di semua tabel. |
| Check-in publik | Supabase Edge Function `check-in` | `supabase/functions/check-in/`. Satu-satunya jalan menulis presensi dari peserta. |

### Alur presensi (QR berganti otomatis)

1. Dashboard admin meminta kode QR baru ke database setiap 15 detik (`admin_get_qr_code`). Kode ditandatangani dengan rahasia sesi yang tidak pernah keluar dari database/admin.
2. Peserta scan → `check-in.html?m=<id rapat>&c=<kode>` → `begin_checkin` memeriksa kode (berlaku ±90 detik) dan memberi **tiket** bertanda tangan yang berlaku 15 menit untuk mengisi formulir.
3. Formulir dikirim ke Edge Function `check-in` → `check_in_secure` memeriksa tiket, status sesi, batas percobaan, lalu menyimpan presensi.

Foto/tautan QR yang diteruskan ke grup chat berhenti berlaku dalam ±90 detik. Untuk rapat online, admin dapat mematikan "QR berganti otomatis" pada rapat tersebut sehingga tautannya tetap.

### Batas percobaan (rate limit)

- Per scan/tiket: maksimal 10 kali kirim. Peserta cukup scan ulang bila tercapai.
- Per alamat jaringan: maksimal 300 percobaan per 10 menit — hanya menghentikan banjir permintaan; satu angkatan di Wi-Fi kampus yang sama **tidak** terblokir.

---

## A. Upgrade production (rilis QR berganti otomatis)

**Status 11 Nov 2026:** langkah 1–3 sudah dijalankan di production (`gbcvawpszyhaqaitysyf`):

- Cadangan dibuat di `private.attendance_backup_20261111` (86 baris) dan `private.meetings_backup_20261111` (2 baris). Hapus setelah rilis terbukti stabil: `drop table private.attendance_backup_20261111, private.meetings_backup_20261111;`
- Migrasi `20261110223726_rotating_qr_admin_tools.sql` diterapkan; 86 presensi utuh, 2 nama dinormalkan ulang.
- Edge Function `check-in` versi 2 aktif (`verify_jwt = false`); secrets `ALLOWED_ORIGIN` dan `RATE_LIMIT_SECRET` terverifikasi berfungsi.
- Riwayat migrasi Supabase sudah sesuai dengan folder `supabase/migrations/`, jadi `supabase db push` berikutnya hanya menjalankan migrasi baru.

Langkah yang tersisa: **4 (frontend)**, **5**, dan **6**. Sampai frontend baru live, situs lama tidak dapat mencatat presensi.

Untuk referensi atau project lain, urutan lengkapnya:

### 1. Cadangkan data

Dashboard admin → **Presensi** → filter *Semua rapat* → **Ekspor CSV**.

### 2. Jalankan migrasi database

Supabase Dashboard → *SQL Editor* → tempel isi file migrasi → **Run** (berjalan sebagai satu transaksi), atau `supabase db push`.

### 3. Deploy Edge Function

```bash
supabase functions deploy check-in --project-ref gbcvawpszyhaqaitysyf
```

`supabase/config.toml` sudah mengatur `verify_jwt = false` (wajib, karena peserta tidak login). Pastikan secrets berikut ada di *Edge Functions → Secrets*:

| Secret | Nilai |
|---|---|
| `ALLOWED_ORIGIN` | `https://the-gladius-attendance.vercel.app` (origin saja, tanpa path; beberapa origin dipisah koma) |
| `RATE_LIMIT_SECRET` | String acak panjang, mis. hasil `openssl rand -hex 32`. Jangan ditaruh di Git/frontend. |

`SUPABASE_URL` dan key server disediakan otomatis oleh Supabase.

### 4. Deploy frontend

Commit dan push ke `main`; Vercel men-deploy otomatis. File database, function, tes, dan dokumentasi tidak ikut dipublikasikan (`.vercelignore`).

### 5. Matikan pendaftaran akun publik

Supabase Dashboard → *Authentication → Sign In / Providers* → nonaktifkan **Allow new users to sign up**. Akun admin dibuat manual (lihat bagian C). Tanpa ini, orang lain tetap tidak bisa mengakses data (tidak punya peran admin), tetapi tidak ada alasan membiarkan pendaftaran terbuka.

### 6. Uji coba setelah deploy (±5 menit)

1. Buka dashboard admin → muat ulang halaman sekali (agar service worker versi baru aktif).
2. **Rapat** → buat rapat "Tes Sistem" → **Buka presensi** (pilih 1 jam) → QR tampil dan garis waktu di bawahnya berjalan.
3. Scan dengan HP (data seluler, bukan Wi-Fi yang sama) → isi nama "Tes" → muncul "Kehadiran tercatat." dan entri langsung muncul di dashboard.
4. Foto QR, tunggu 2 menit, scan foto itu → harus muncul "QR sudah berganti."
5. **Presensi** → hapus entri "Tes" → klik **Urungkan** → entri kembali → hapus lagi.
6. **Rapat** → hapus rapat "Tes Sistem".
7. Supabase → *Edge Functions → check-in → Logs*: tidak ada error.

Jika langkah 3 gagal, lihat bagian E.

---

## B. Setup dari nol (project Supabase baru)

1. Buat project Supabase. Catat *Project URL* dan *Publishable key* (Settings → API Keys).
2. Jalankan kedua migrasi berurutan (SQL Editor atau `supabase db push`).
3. Deploy Edge Function dan isi secrets (bagian A.3).
4. Isi `js/config.js` dengan URL dan publishable key. **Jangan** pernah menaruh secret/service-role key di frontend.
5. Ganti project ref `gbcvawpszyhaqaitysyf` di `vercel.json` (`connect-src` pada Content-Security-Policy) dengan project ref baru.
6. Deploy ke Vercel (framework preset: *Other*, tanpa build command, output directory: root).
7. Buat akun admin (bagian C) dan matikan pendaftaran publik (A.5).

---

## C. Menambah administrator

1. Supabase → *Authentication → Users → Add user* → isi email & kata sandi (centang *Auto Confirm User*).
2. Salin *User UID*, lalu di SQL Editor:

```sql
insert into public.profiles (id, display_name, role)
values ('<USER UID>', 'Nama Admin', 'admin');
```

Mencabut akses: `delete from public.profiles where id = '<USER UID>';`

---

## D. Fitur admin & pemulihan data

| Kebutuhan | Di dashboard |
|---|---|
| Durasi sesi | Dipilih saat **Buka presensi** (1–12 jam). |
| Sesi habis waktu padahal rapat masih berlangsung | **Perpanjang** — QR yang tampil tetap berlaku. |
| Sesi tertutup tidak sengaja | **Buka ulang** — QR baru dibuat; presensi lama tetap ada. |
| QR/tautan tersebar ke luar ruangan | **Ganti QR** — semua QR, tautan, dan formulir lama langsung tidak berlaku. |
| Peserta hadir tetapi HP mati | **Presensi → Tambah presensi manual** (ditandai "Manual" dan tercatat di CSV). |
| Entri iseng/salah | **Hapus** di tabel presensi, dengan tombol **Urungkan** sesaat setelahnya. |
| Kemungkinan orang yang sama tercatat dua kali ("Budi S." & "Budi Santoso") | Tanda **Cek duplikat** + filter *Hanya kemungkinan duplikat*. Database sudah menolak duplikat persis (nama + prodi sama, abaikan huruf besar/tanda baca). |
| Rapat dibuat salah | **Hapus** pada kartu rapat. |

Semua presensi yang dihapus (termasuk karena rapatnya dihapus) disimpan di tabel `private.attendance_archive`, yang tidak dapat diakses dari API. Melihat dan memulihkan lewat SQL Editor:

```sql
-- Lihat arsip terbaru
select archive_id, meeting_title, full_name, study_program_name, checked_in_at, archive_reason, archived_at
from private.attendance_archive where restored_at is null order by archived_at desc limit 50;

-- Pulihkan presensi dari rapat yang dihapus: buat ulang rapatnya dulu bila perlu,
-- lalu sisipkan kembali dengan meeting_id yang benar.
insert into public.attendance (id, meeting_id, full_name, normalized_name, study_program_id, study_program_name, checked_in_at, source, recorded_by)
select attendance_id, '<MEETING ID>', full_name, normalized_name, study_program_id, study_program_name, checked_in_at, source, recorded_by
from private.attendance_archive where archive_id = '<ARCHIVE ID>';
update private.attendance_archive set restored_at = now() where archive_id = '<ARCHIVE ID>';
```

---

## E. Pemecahan masalah

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| Dashboard/peserta: "Database belum diperbarui…" / "Layanan presensi sedang diperbarui" | Frontend baru sudah live, migrasi belum dijalankan | Jalankan migrasi (A.2). |
| Peserta: "Server menolak format permintaan" tepat setelah upgrade | Edge Function lama masih aktif | Deploy function (A.3). |
| Peserta: pesan tentang `ALLOWED_ORIGIN` / CORS | Secret kosong atau tidak sama persis dengan domain | Isi `ALLOWED_ORIGIN` dengan origin persis (A.3), tanpa `/` di akhir. |
| Peserta: "QR sudah berganti" padahal baru scan | Halaman baru terbuka >90 detik setelah QR tampil, atau QR di layar tidak diperbarui karena laptop admin offline (dialog QR menampilkan peringatan). Jam HP/laptop tidak berpengaruh—waktu berasal dari server. | Scan ulang QR yang sedang tampil; pastikan laptop admin online dan dialog QR tetap terbuka. |
| Dialog QR menampilkan peringatan `localhost` | Dashboard dibuka dari `localhost` saat uji lokal | Buka lewat alamat jaringan atau isi `checkInBaseUrl` di `js/config.js`. |
| "Pembaruan langsung terputus" di dashboard | Koneksi realtime putus | Otomatis memuat ulang data saat tersambung kembali; atau muat ulang halaman. |
| Perubahan frontend tidak muncul di HP | Cache service worker | Naikkan `CACHE_NAME` di `service-worker.js` setiap rilis yang mengubah file yang di-precache. JS/CSS memakai network-first, jadi biasanya cukup muat ulang. |

Log server: Supabase → *Edge Functions → check-in → Logs* (tidak memuat nama peserta atau tiket).

---

## F. Pengembangan & tes lokal

```bash
npm test            # unit test frontend (Node ≥ 20)
npm run test:sql    # migrasi + 67 tes perilaku database pada PostgreSQL lokal sementara
                    # (butuh initdb/pg_ctl/psql di PATH, atau set DATABASE_URL ke server Postgres superuser)
npm run test:edge   # unit test Edge Function (Deno)
npm run test:all
```

Ketiganya juga berjalan otomatis di GitHub Actions (`.github/workflows/ci.yml`).

Menjalankan situs secara lokal: `npx serve .` lalu buka alamat *Network* yang ditampilkan (bukan `localhost`) agar QR bisa dibuka dari HP. Untuk uji check-in lokal, tambahkan origin tersebut ke `ALLOWED_ORIGIN`.

Mengubah library vendor: lihat `js/vendor/LICENSES.md`.
