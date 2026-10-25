# The Gladius 26 Attendance

**Presensi rapat Fakultas Teknik Angkatan 2026, lebih praktis dengan QR code.**

The Gladius 26 Attendance adalah aplikasi presensi berbasis web untuk membantu pengelolaan rapat mingguan Fakultas Teknik Angkatan 2026. Admin dapat menyiapkan rapat dan membuka sesi presensi, sementara peserta cukup memindai QR code melalui kamera ponsel untuk mengisi kehadiran.

Aplikasi dirancang dengan antarmuka yang minimalis, responsif, dan mudah digunakan melalui laptop, tablet, maupun ponsel.

## Fitur Utama

- **Pengelolaan rapat** — membuat, mengedit, dan melihat riwayat rapat.
- **Sesi presensi terkontrol** — admin dapat membuka dan menutup presensi sesuai kebutuhan rapat.
- **QR code khusus setiap sesi** — setiap sesi memiliki tautan presensi tersendiri.
- **Check-in melalui ponsel** — peserta mengisi nama dan program studi dari browser tanpa wajib memasang aplikasi.
- **Dashboard kehadiran** — melihat catatan presensi yang berhasil disimpan.
- **Pengelolaan program studi** — daftar pilihan program studi tersedia secara terpusat.
- **Pencarian dan filter** — membantu admin menemukan catatan presensi.
- **Ekspor laporan CSV** — mengunduh data presensi untuk dokumentasi dan pengolahan lebih lanjut.
- **Tampilan responsif** — antarmuka menyesuaikan layar desktop dan perangkat mobile.
- **Dukungan PWA** — dapat ditambahkan ke Home Screen pada browser dan perangkat yang mendukung.
- **Antarmuka berbahasa Indonesia** — dirancang agar dapat digunakan tanpa langkah yang rumit.

## Cara Penggunaan

### Untuk Admin

1. Masuk ke ruang administrator.
2. Buat rapat dan lengkapi informasi yang diperlukan.
3. Buka sesi presensi ketika presensi akan dimulai.
4. Tampilkan QR code agar peserta dapat memindainya.
5. Pantau catatan kehadiran dari dashboard.
6. Tutup sesi presensi setelah selesai dan ekspor laporan bila diperlukan.

### Untuk Peserta

1. Pindai QR code yang ditampilkan oleh admin menggunakan kamera ponsel.
2. Pastikan halaman menunjukkan rapat yang benar.
3. Masukkan nama dan pilih program studi.
4. Kirim formulir presensi.
5. Tunggu konfirmasi bahwa kehadiran berhasil dicatat.

Peserta tidak perlu membuat akun atau memasang PWA untuk melakukan check-in.

## Privasi dan Integritas Presensi

- Catatan kehadiran hanya dianggap berhasil setelah dikonfirmasi oleh server.
- Waktu check-in bersumber dari waktu server/database dan ditampilkan dalam zona waktu WITA (Asia/Makassar).
- Check-in hanya dapat dilakukan melalui sesi yang valid dan sedang terbuka.
- Sistem mencegah pengiriman presensi ganda berdasarkan nama dan program studi dalam rapat yang sama.
- Akses pengelolaan data dibatasi untuk administrator yang berwenang.

**Catatan:** QR code memastikan peserta memiliki tautan sesi, tetapi tidak dapat membuktikan secara mandiri bahwa peserta hadir secara fisik. Tautan QR juga dapat dibagikan kepada orang lain. Admin sebaiknya menampilkan QR hanya saat rapat berlangsung dan menutup presensi setelah selesai.

## Kebutuhan Penggunaan

- Koneksi internet diperlukan untuk memuat data rapat dan menyimpan presensi.
- Peserta perlu membuka QR dari sesi yang benar dan masih aktif.
- Fitur instalasi ke Home Screen bergantung pada dukungan browser dan perangkat.

## Tentang Proyek

The Gladius 26 Attendance dibuat untuk menyederhanakan administrasi presensi rapat Fakultas Teknik Angkatan 2026, mengurangi pencatatan manual, dan memudahkan rekap kehadiran melalui satu dashboard.

---

*The Gladius 26 Attendance — Scan. Check in. Stay connected.*

## Made by Mikael Kalesaran

The Gladius, Rise As One!