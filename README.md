# The Gladius 26 Attendance

**Presensi rapat Fakultas Teknik Angkatan 2026, lebih praktis dengan QR code.**

The Gladius 26 Attendance adalah aplikasi presensi berbasis web untuk membantu pengelolaan rapat mingguan Fakultas Teknik Angkatan 2026. Admin dapat menyiapkan rapat dan membuka sesi presensi, sementara peserta cukup memindai QR code melalui kamera ponsel untuk mengisi kehadiran.

Aplikasi dirancang dengan antarmuka yang minimalis, responsif, dan mudah digunakan melalui laptop, tablet, maupun ponsel.

## Fitur Utama

- **Pengelolaan rapat** — membuat, mengedit, dan melihat riwayat rapat.
- **Sesi presensi terkontrol** — admin membuka sesi dengan durasi pilihan (1–12 jam), lalu dapat memperpanjang, menutup, atau membuka ulang sesi.
- **QR berganti otomatis** — QR di layar berganti setiap 15 detik, sehingga foto atau tautan yang diteruskan ke grup chat berhenti berlaku dalam ±90 detik. Untuk rapat online tersedia mode tautan tetap.
- **Ganti QR darurat** — jika QR tersebar ke luar ruangan, admin dapat membatalkan semua QR dan tautan lama sekaligus.
- **Mode layar penuh** — QR dapat ditampilkan besar di proyektor.
- **Check-in melalui ponsel** — peserta mengisi nama dan program studi dari browser tanpa wajib memasang aplikasi.
- **Dashboard kehadiran** — catatan presensi muncul langsung saat peserta check-in.
- **Koreksi data** — hapus entri yang salah (dengan tombol *Urungkan*), tambah presensi manual untuk peserta yang tidak bisa scan, dan tanda *Cek duplikat* untuk nama yang mirip ("Budi S." dan "Budi Santoso").
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
4. Tampilkan QR code (sebaiknya layar penuh di proyektor) agar peserta dapat memindainya. Biarkan dialog QR terbuka selama presensi—QR diperbarui otomatis.
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
- Sistem mencegah pengiriman presensi ganda berdasarkan nama dan program studi dalam rapat yang sama (huruf besar/kecil dan tanda baca diabaikan).
- QR berganti setiap 15 detik dan setiap scan hanya berlaku 15 menit untuk mengisi formulir.
- Entri yang dihapus admin disimpan di arsip database dan dapat dipulihkan.
- Akses pengelolaan data dibatasi untuk administrator yang berwenang.

**Catatan:** QR yang berganti otomatis membuat tautan yang diteruskan cepat kedaluwarsa, tetapi tidak dapat membuktikan secara mandiri bahwa peserta hadir secara fisik—seseorang di ruangan tetap bisa mengirim foto QR terbaru secara langsung. Admin sebaiknya menampilkan QR hanya saat rapat berlangsung, menutup presensi setelah selesai, dan memakai **Ganti QR** bila QR tersebar.

## Kebutuhan Penggunaan

- Koneksi internet diperlukan untuk memuat data rapat dan menyimpan presensi.
- Peserta perlu membuka QR dari sesi yang benar dan masih aktif.
- Fitur instalasi ke Home Screen bergantung pada dukungan browser dan perangkat.

## Untuk Pengelola Teknis

Panduan deploy, upgrade database, pembuatan akun admin, pemulihan data, dan pemecahan masalah ada di [docs/DEPLOY.md](docs/DEPLOY.md).

## Tentang Proyek

The Gladius 26 Attendance dibuat untuk menyederhanakan administrasi presensi rapat Fakultas Teknik Angkatan 2026, mengurangi pencatatan manual, dan memudahkan rekap kehadiran melalui satu dashboard.

---

*The Gladius 26 Attendance — Scan. Check in. Stay connected.*

## Made by Mikael Kalesaran

The Gladius, Rise As One!