import { isMissingDatabaseFunction } from "./supabase-errors.js";

const MESSAGES = {
  not_authorized: "Akun ini tidak memiliki akses administrator.",
  invalid_state_transition: "Status sesi sudah berubah. Data dimuat ulang; periksa lalu coba lagi.",
  invalid_status: "Status sesi tidak dikenal.",
  invalid_duration: "Durasi sesi harus antara 15 menit dan 24 jam.",
  meeting_not_found: "Rapat tidak ditemukan. Mungkin sudah dihapus.",
  session_not_open: "Sesi presensi tidak sedang dibuka.",
  already_recorded: "Peserta dengan nama dan program studi ini sudah tercatat di rapat tersebut.",
  invalid_name: "Nama harus 2–100 karakter dan memuat huruf atau angka.",
  invalid_program: "Program studi tidak ditemukan.",
  invalid_title: "Nama rapat harus 3–120 karakter.",
  invalid_date: "Tanggal rapat wajib diisi.",
  invalid_notes: "Catatan maksimal 1000 karakter.",
  attendance_not_found: "Catatan presensi tidak ditemukan. Mungkin sudah dihapus.",
  archive_not_found: "Catatan ini sudah dipulihkan atau tidak ada di arsip.",
};

/** Maps an error raised by an admin_* database function to an Indonesian message. */
export function adminErrorMessage(error, fallback) {
  const message = String(error?.message || "").trim();
  if (MESSAGES[message]) return MESSAGES[message];
  if (isMissingDatabaseFunction(error)) {
    return "Database belum diperbarui ke versi aplikasi ini. Jalankan migrasi terbaru (lihat docs/DEPLOY.md).";
  }
  return fallback;
}
