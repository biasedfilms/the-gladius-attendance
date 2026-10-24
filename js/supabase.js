import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const config = window.GLADIUS_CONFIG;
const publishableKey =
  config?.supabasePublishableKey || config?.supabaseAnonKey;
export const isSupabaseConfigured = Boolean(
  config?.supabaseUrl &&
  publishableKey &&
  !config.supabaseUrl.includes("YOUR_PROJECT_REF") &&
  !publishableKey.startsWith("YOUR_"),
);
export const supabase = isSupabaseConfigured
  ? createClient(config.supabaseUrl, publishableKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null;
export const displayDate = (value, options = {}) =>
  value
    ? new Intl.DateTimeFormat("id-ID", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Asia/Makassar",
        ...options,
      }).format(new Date(value))
    : "—";
export const displayTime = (value) =>
  value
    ? new Intl.DateTimeFormat("id-ID", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Makassar",
        hour12: false,
      })
        .format(new Date(value))
        .replace(".", ":")
    : "—";
export const displayDateTime = (value) =>
  value
    ? new Intl.DateTimeFormat("id-ID", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Makassar",
      })
        .format(new Date(value))
        .replace(",", " ·")
        .replace(".", ":") + " WITA"
    : "—";
export const escapeHtml = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
export const setFeedback = (element, message = "", type = "") => {
  if (!element) return;
  element.textContent = message;
  element.className = `feedback${type ? ` feedback-${type}` : ""}`;
};
export const safeError = (error) => {
  const message = String(error?.message || "");
  if (/Invalid login credentials/i.test(message))
    return "Email atau kata sandi tidak sesuai.";
  if (/Failed to fetch|NetworkError|fetch failed/i.test(message))
    return "Tidak dapat terhubung ke server. Periksa internet dan konfigurasi.";
  if (/JWT|session|auth/i.test(message) && /expired|invalid/i.test(message))
    return "Sesi login berakhir. Silakan masuk kembali.";
  return "Permintaan belum berhasil. Periksa koneksi dan konfigurasi, lalu coba lagi.";
};
