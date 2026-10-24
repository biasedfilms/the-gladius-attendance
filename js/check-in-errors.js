const originNow = () => globalThis.location?.origin || "domain ini";

export function functionCodeMessage(code) {
  const messages = {
    origin_not_allowed: `Domain presensi belum diizinkan oleh server. Admin perlu menambahkan origin ${originNow()} ke ALLOWED_ORIGIN di Supabase (tanpa path).`,
    server_not_configured: "Layanan presensi belum dikonfigurasi di Supabase. Admin perlu memeriksa secret Edge Function, terutama ALLOWED_ORIGIN dan RATE_LIMIT_SECRET.",
    invalid_request: "Server menolak format permintaan. Muat ulang halaman dan coba kembali; jika tetap gagal, hubungi administrator.",
    server_error: "Server gagal menyimpan presensi. Administrator perlu memeriksa log Edge Function check-in dan fungsi SQL check_in_secure di Supabase.",
  };
  return messages[code] || null;
}

export async function checkInFailureMessage(error) {
  const status = Number.isFinite(error?.context?.status)
    ? error.context.status
    : null;
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

  // Keep diagnostics actionable without logging the participant's name or QR token.
  console.error("[Gladius check-in] Request failed", {
    type: error?.name || "Error",
    status,
    code: code || null,
    message: error?.message || "Unknown error",
  });

  const codeMessage = functionCodeMessage(code);
  if (codeMessage) return codeMessage;
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
    return `Browser tidak menerima respons dari layanan presensi. Periksa koneksi internet; jika internet normal, administrator perlu memeriksa CORS dan memastikan ALLOWED_ORIGIN memuat ${originNow()} persis.`;
  }
  return "Permintaan belum berhasil. Periksa koneksi dan konfigurasi, lalu coba lagi.";
}
