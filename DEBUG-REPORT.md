# Laporan Audit dan Perbaikan Bug Presensi

**Proyek:** The Gladius 26 Attendance  
**Fokus:** Check-in mahasiswa melalui QR code di ponsel  
**Hasil:** Perbaikan kode diagnostik dan cache selesai; pemeriksaan runtime produksi tetap memerlukan Supabase Logs.

## 1. Kesimpulan

Dari screenshot dan source code, error terjadi ketika halaman mengirim formulir ke **Supabase Edge Function `check-in`**. Ini bukan error validasi nama/program studi yang biasa ditampilkan aplikasi.

Alurnya memperlihatkan bahwa halaman berhasil memvalidasi sesi rapat dan memuat daftar program studi. Ketika pengiriman dilakukan, `supabase.functions.invoke(...)` melempar error lalu masuk ke blok `catch` di `js/check-in.js`. Bukti UI-nya adalah formulir masih terlihat, tombol berubah menjadi **“Coba kirim lagi”**, dan pesan merah generik tetap berada di formulir. Jika server mengembalikan hasil bisnis seperti QR kedaluwarsa atau program studi tidak valid melalui jalur normal, kode lama mengganti tampilan formulir dengan halaman error, bukan mempertahankan tombol coba lagi.

### Hal yang belum bisa dipastikan

Source ZIP dan screenshot tidak menyertakan log runtime Supabase. Akses langsung ke domain produksi juga tidak berhasil dari lingkungan audit ini, jadi penyebab konfigurasi produksi yang tepat **belum dapat diverifikasi**. Jangan menganggap satu kemungkinan di bawah sebagai fakta sebelum mengecek log.

## 2. Penyebab yang paling relevan untuk diperiksa

1. **`ALLOWED_ORIGIN` kosong atau tidak cocok.** Kode Edge Function awal membandingkan header browser `Origin` dengan `ALLOWED_ORIGIN` secara persis. Domain situs yang terlihat di screenshot adalah `https://the-gladius-attendance.vercel.app`. Jika secret berisi domain lain, URL preview, path, atau garis miring di akhir, request dapat ditolak. Pada implementasi lama, respons penolakan juga memiliki header CORS untuk origin yang diizinkan, sehingga browser mahasiswa bisa menyembunyikan body error dan hanya melaporkan kegagalan request.
2. **Secret Edge Function belum lengkap.** Kode memerlukan URL Supabase, key server dengan hak yang sesuai, dan `RATE_LIMIT_SECRET`. Jika salah satu tidak tersedia, fungsi harus mengembalikan `server_not_configured`. Pastikan `ALLOWED_ORIGIN` juga terisi, karena pemeriksaan origin berjalan lebih dulu.
3. **Edge Function belum di-deploy ke project yang dipakai frontend**, atau deployment memakai pengaturan verifikasi JWT yang tidak sesuai. Fungsi publik ini diatur dengan `verify_jwt = false` pada `supabase/config.toml`; perlindungan request ditangani dengan validasi di fungsi, allow-list origin, rate limit, dan RPC database yang khusus untuk service role.
4. **Gangguan jaringan atau preflight/CORS.** Ini dapat menghasilkan error fetch yang tidak memuat status HTTP atau JSON dari fungsi.
5. **JavaScript lama tertahan di Service Worker.** Aturan awal cache-first untuk file `.js` dan `.css` dapat membuat browser terus menggunakan aset lama setelah deployment apabila nama cache tidak dinaikkan.

## 3. Perubahan yang diterapkan

### `js/check-in.js` dan `js/check-in-errors.js`

- Memisahkan pemetaan error ke modul yang bisa diuji otomatis.
- Membaca `status` dan kode JSON dari `FunctionsHttpError` bila respons bisa diakses.
- Menampilkan pesan berbeda untuk konfigurasi server, origin ditolak, endpoint tidak ditemukan, masalah autentikasi fungsi, rate limit, dan error server.
- Untuk error fetch/CORS yang body-nya tidak bisa dibaca, pesan sekarang menyebut bahwa koneksi dan CORS/`ALLOWED_ORIGIN` perlu diperiksa, tanpa mengklaim salah satunya pasti penyebabnya.
- Log browser hanya menyimpan tipe error, status, kode, dan pesan error. Nama mahasiswa dan token QR tidak dimasukkan ke log diagnostik.

### `supabase/functions/check-in/index.ts`

- `ALLOWED_ORIGIN` kini menerima satu atau beberapa origin eksplisit yang dipisahkan koma.
- Spasi konfigurasi dan garis miring akhir dihapus sebelum pencocokan origin.
- Jika origin belum dikonfigurasi, preflight dapat selesai dan POST mengembalikan error konfigurasi yang dapat dibaca frontend; check-in tetap ditolak sampai konfigurasi dilengkapi.
- Log server mencatat origin yang ditolak atau keberadaan variabel konfigurasi dengan nilai boolean, bukan isi secret.
- Respons kesalahan database tetap generik untuk pengguna publik; detail database tidak dikirim ke browser.

### `service-worker.js`

- Nama cache dinaikkan agar cache lama dibersihkan saat Service Worker baru aktif.
- File JavaScript dan CSS kini menggunakan network-first, dengan cache hanya sebagai fallback saat offline. Ini mengurangi risiko ponsel menjalankan logika presensi versi lama setelah deployment.

### Tes

File `tests/check-in-errors.test.mjs` menambahkan tes untuk respons konfigurasi hilang, endpoint tidak ditemukan, diagnosis CORS/fetch, origin ditolak, dan rate limit.

## 4. Langkah verifikasi pada project Supabase produksi

1. Buka **Supabase Dashboard → Edge Functions → `check-in` → Logs**. Lakukan satu percobaan presensi dan periksa log baru. Cari pesan seperti `ALLOWED_ORIGIN is not configured`, `Rejected origin`, `Server secrets are incomplete`, atau `check_in_secure failed`.
2. Di **Edge Function Secrets**, periksa:
   - `ALLOWED_ORIGIN`: `https://the-gladius-attendance.vercel.app` untuk domain pada screenshot. Jika memakai domain lain, tambahkan origin itu ke daftar dengan pemisah koma. Masukkan origin saja, tanpa path seperti `/check-in.html`.
   - `RATE_LIMIT_SECRET`: nilai acak panjang. Jangan masukkan nilai ini ke `js/config.js`, Git, screenshot, atau chat.
   - Key server yang dapat menjalankan `check_in_secure`, yaitu `SUPABASE_SECRET_KEY` atau `SUPABASE_SERVICE_ROLE_KEY` (sesuai konfigurasi runtime). Pastikan `SUPABASE_URL` juga tersedia; nilai secret tidak perlu ditulis ke laporan.
3. Deploy ulang Edge Function dari folder proyek, dengan Supabase CLI dan akses ke project yang benar:

   ```bash
   supabase functions deploy check-in --project-ref gbcvawpszyhaqaitysyf
   ```

   Pastikan konfigurasi `verify_jwt = false` dari `supabase/config.toml` ikut digunakan.
4. Deploy frontend yang sudah diperbaiki ke Vercel. Setelah itu buka ulang tautan QR di Safari. Service Worker yang baru akan mengganti cache lama; jika halaman masih berperilaku lama, tutup tab/PWA sepenuhnya lalu buka ulang.
5. Coba kirim **sekali** dan periksa Dashboard kehadiran. Bila browser timeout setelah server sempat menyimpan data, data mungkin sudah tercatat meskipun konfirmasi tidak sampai ke ponsel. Periksa dashboard terlebih dahulu sebelum mengulang; proteksi duplikat di database tetap menjadi pengaman tambahan.

## 5. Cara membaca status error

| Indikasi | Arti yang paling mungkin | Pemeriksaan berikutnya |
|---|---|---|
| `origin_not_allowed` / browser fetch error | Origin website tidak masuk allow-list atau preflight gagal | Samakan `ALLOWED_ORIGIN` dengan `location.origin`; lihat log Edge Function |
| `server_not_configured` / HTTP 503 | Konfigurasi/secret fungsi belum lengkap | Periksa nama variabel dan ketersediaan nilainya, tanpa membagikan nilai secret |
| HTTP 404 | Function name atau deployment/project tidak cocok | Pastikan `check-in` ada di project Supabase yang sama dengan frontend |
| HTTP 401 | Pengaturan autentikasi Edge Function tidak sesuai | Pastikan deployment memakai `verify_jwt = false` untuk endpoint publik ini |
| HTTP 500 / `server_error` | RPC `check_in_secure` atau akses database gagal | Baca log Edge Function dan periksa migrasi/grant pada database |
| `FunctionsFetchError` tanpa status | Browser tidak mendapat respons yang bisa dibaca | Periksa internet, preflight/CORS, `ALLOWED_ORIGIN`, serta log fungsi |

## 6. Hasil tes lokal

Perintah yang dijalankan pada source hasil perbaikan:

```text
node --check js/check-in.js                  PASS
node --check js/check-in-errors.js            PASS
node --check js/supabase.js                   PASS
node --check service-worker.js                PASS
node --test tests/check-in-errors.test.mjs    PASS — 5 tests, 0 failures
git diff --check                             PASS
TypeScript static check for Edge Function     PASS
```

Tes ini memverifikasi sintaks dan pemetaan error di sisi frontend serta pemeriksaan statis Edge Function. Tes ini **tidak** membuktikan bahwa secret produksi benar, function produksi sudah ter-deploy, atau koneksi database produksi berjalan; hal-hal tersebut harus dikonfirmasi di Supabase Dashboard.

## 7. Pencegahan agar tidak terulang

- Untuk setiap kegagalan submit, simpan status HTTP dan kode error aman; jangan mengubah semua error menjadi pesan koneksi generik.
- Setelah mengubah Edge Function atau variabel server, lakukan deploy dan satu uji check-in pada domain produksi yang tepat.
- Pertahankan allow-list origin yang eksplisit; jangan memakai wildcard CORS sebagai jalan pintas.
- Jangan pernah memasukkan key service-role/secret ke file frontend.
- Pertahankan tes diagnostik, dan periksa Supabase Logs ketika status menunjukkan server error.
- Gunakan strategi network-first atau versioning aset yang disiplin untuk file JS/CSS yang di-cache Service Worker.
- Ketika respons hilang setelah pengiriman, cek catatan admin sebelum mengulang berkali-kali agar tidak membingungkan peserta dan tidak memicu rate limit.
