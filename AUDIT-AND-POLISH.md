# Audit dan Polish — The Gladius 26 Attendance

## Perubahan pada source

- Mengganti placeholder huruf **G** dengan logo PNG The Gladius yang diberikan, di halaman beranda, login, dashboard admin, check-in, dan halaman offline.
- Memperbarui favicon, ikon PWA Android, ikon maskable, dan ikon **Add to Home Screen** iOS dari logo yang sama. Versi cache Service Worker dinaikkan agar aset lama diganti setelah deployment.
- Menyelaraskan warna UI ke navy The Gladius dengan aksen emas yang lebih hemat; layout utama dan alur presensi tetap dipertahankan.
- Menambahkan pagination pada query rapat, program studi, dan presensi di dashboard admin. Sebelumnya query tanpa pagination berisiko terpotong pada batas hasil REST Supabase, sehingga statistik dan ekspor CSV bisa tidak mencakup semua catatan lama.
- Memperbaiki pesan kegagalan submit saat browser tidak menerima respons. Sekarang UI menjelaskan status mungkin belum dapat dipastikan dan meminta admin memeriksa dashboard sebelum peserta mencoba ulang, untuk menghindari duplikasi percobaan setelah respons hilang.
- Menjaga font input minimal 16px pada layar kecil agar Safari iOS tidak melakukan zoom otomatis saat fokus.
- Merapikan heading README serta menambahkan aturan ignore untuk metadata lokal Supabase.

## Pemeriksaan yang dilakukan

- Tes unit `tests/check-in-errors.test.mjs` dan `tests/paginated-query.test.mjs` (termasuk simulasi 1.203 baris melewati beberapa halaman).
- Pemeriksaan sintaks Node untuk seluruh file JavaScript dan Service Worker.
- Pemeriksaan referensi asset pada halaman dan manifest.
- Diff/struktur source diperiksa untuk memastikan logo dan cache version ikut dalam paket.

## Batas audit

Audit ini berbasis source ZIP. Tidak ada penulisan data ke database produksi. Koneksi langsung ke Supabase, secret Edge Function, deployment Vercel, autentikasi admin, dan check-in end-to-end di domain produksi tidak dapat dinyatakan lulus hanya dari tes lokal; setelah deploy, lakukan satu tes check-in terkendali dan periksa dashboard serta Edge Function Logs. Jangan menaruh service-role/secret key pada `js/config.js` atau file frontend.
