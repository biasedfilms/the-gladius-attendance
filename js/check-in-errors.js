import { isMissingDatabaseFunction } from "./supabase-errors.js";

const originNow = () => globalThis.location?.origin || "domain ini";

const RESCAN = "Scan ulang QR yang sedang tampil di layar rapat.";

/** Outcome codes returned by check_in_secure (through the Edge Function). */
const RESULT_MESSAGES = {
  session_invalid: `QR ini sudah tidak berlaku, misalnya karena admin membuat QR baru. ${RESCAN}`,
  session_closed: "Presensi telah ditutup. Kehadiran baru tidak dapat dicatat.",
  session_expired: "Sesi presensi sudah berakhir. Minta administrator memperpanjang sesi.",
  session_not_open: "Presensi belum dibuka oleh administrator.",
  ticket_expired: `Waktu pengisian formulir (15 menit) sudah habis. ${RESCAN}`,
  invalid_name: "Nama tidak valid. Gunakan 2–100 karakter yang memuat huruf.",
  invalid_program: "Program studi tidak valid atau sudah tidak aktif. Muat ulang halaman lalu pilih lagi.",
  rate_limited: `Terlalu banyak percobaan dari QR scan ini. ${RESCAN}`,
};

/** Reasons returned by begin_checkin when a scanned link cannot be used. */
const BEGIN_MESSAGES = {
  code_expired: ["QR sudah berganti.", `QR presensi berganti setiap 15 detik dan tautan ini sudah lewat. ${RESCAN}`],
  rotating_required: ["Tautan ini sudah tidak berlaku.", `Rapat ini memakai QR yang berganti otomatis. ${RESCAN}`],
  invalid: ["Sesi tidak ditemukan.", `QR ini tidak valid atau sesi sudah diganti. ${RESCAN}`],
};

export function beginFailureMessage(reason) {
  return BEGIN_MESSAGES[reason] || BEGIN_MESSAGES.invalid;
}

export function functionCodeMessage(code) {
  const messages = {
    ...RESULT_MESSAGES,
    origin_not_allowed: `Domain presensi belum diizinkan oleh server. Admin perlu menambahkan origin ${originNow()} ke ALLOWED_ORIGIN di Supabase (tanpa path).`,
    server_not_configured: "Layanan presensi belum dikonfigurasi di Supabase. Admin perlu memeriksa ALLOWED_ORIGIN, SUPABASE_URL, key server (secret/service-role), dan RATE_LIMIT_SECRET di Edge Function Secrets.",
    invalid_request: `Server menolak format permintaan. ${RESCAN} Jika tetap gagal, hubungi administrator.`,
    server_error: "Server gagal memproses presensi. Administrator perlu memeriksa log Edge Function check-in serta fungsi SQL check_in_secure di Supabase.",
  };
  return messages[code] || null;
}

export async function checkInFailureMessage(error) {
  const status = Number.isFinite(error?.context?.status) ? error.context.status : null;
  let code = "";

  // Supabase FunctionsHttpError stores its HTTP Response in `context`.
  // Read a clone so diagnostics do not consume the original Response.
  if (error?.context && typeof error.context.clone === "function") {
    try {
      const payload = await error.context.clone().json();
      if (typeof payload?.code === "string") code = payload.code;
    } catch {
      // Non-JSON gateway/CORS responses are handled by status/name below.
    }
  }

  // Keep diagnostics actionable without logging the participant's name or ticket.
  console.error("[Gladius check-in] Request failed", {
    type: error?.name || "Error",
    status,
    code: code || null,
    message: error?.message || "Unknown error",
  });

  const codeMessage = functionCodeMessage(code);
  if (codeMessage) return codeMessage;
  if (isMissingDatabaseFunction(error)) {
    return "Layanan presensi sedang diperbarui. Coba lagi beberapa saat lagi atau hubungi administrator.";
  }
  if (status === 404) {
    return "Endpoint presensi tidak ditemukan. Administrator perlu memastikan Edge Function bernama check-in sudah di-deploy ke project Supabase yang benar.";
  }
  if (status === 401) {
    return "Server menolak autentikasi fungsi. Administrator perlu memastikan check-in memakai konfigurasi fungsi publik yang benar (verify_jwt = false), lalu deploy ulang.";
  }
  if (status === 403) {
    return `Server menolak permintaan. Administrator perlu memeriksa daftar ALLOWED_ORIGIN di Supabase dan mencocokkannya dengan ${originNow()}.`;
  }
  if (status === 429) {
    return "Terlalu banyak percobaan presensi dalam waktu singkat. Tunggu beberapa menit sebelum mencoba lagi.";
  }
  if (status !== null && status >= 500) {
    return "Layanan presensi sedang gagal di sisi server. Administrator perlu memeriksa secret Edge Function dan log check-in di Supabase.";
  }

  const failureSignature = `${error?.name || ""} ${error?.message || ""}`;
  if (/FunctionsFetchError|Failed to send a request|Failed to fetch|NetworkError|Load failed/i.test(failureSignature)) {
    return `Browser tidak menerima respons dari layanan presensi. Status pengiriman belum dapat dipastikan—server mungkin sudah menyimpan data sebelum koneksi terputus. Tekan "Coba kirim lagi": jika data sudah tersimpan, halaman akan menampilkan bahwa kehadiranmu sudah tercatat. Jika tetap gagal, periksa koneksi/CORS dan pastikan ALLOWED_ORIGIN memuat ${originNow()} persis.`;
  }
  return "Permintaan belum berhasil. Periksa koneksi lalu tekan \"Coba kirim lagi\". Jika data sudah tersimpan, halaman akan menampilkan bahwa kehadiranmu sudah tercatat.";
}
