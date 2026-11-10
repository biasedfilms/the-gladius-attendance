// Pure helpers for the check-in Edge Function (unit-tested in lib.test.ts).

export const TICKET_PATTERN =
  /^t1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9]{1,12}\.[0-9a-f]{16}\.[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ALLOWED_ORIGIN may hold one or more exact origins separated by commas. */
export function parseAllowedOrigins(value: string | undefined | null): string[] {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function normalizeOrigin(value: string | null): string {
  return String(value || "").replace(/\/+$/, "");
}

export type CheckInInput = { ticket: string; fullName: string; programId: string };

/** Validates the JSON body. Returns null when the request is malformed. */
export function parseCheckInBody(body: unknown): CheckInInput | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const ticket = typeof record.ticket === "string" ? record.ticket.trim() : "";
  const fullName = typeof record.full_name === "string" ? record.full_name.trim().replace(/\s+/g, " ") : "";
  const programId = typeof record.study_program_id === "string" ? record.study_program_id.trim() : "";
  if (!TICKET_PATTERN.test(ticket)) return null;
  if (fullName.length < 2 || fullName.length > 100) return null;
  if (!UUID_PATTERN.test(programId)) return null;
  return { ticket, fullName, programId: programId.toLowerCase() };
}

/**
 * Best-effort client address, used only (hashed) for a generous flood limit. The
 * primary limit is per check-in ticket, so a wrong or shared address never blocks a
 * class. Order kept from the original deployment, which produced distinct values
 * per device in production.
 */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return headers.get("cf-connecting-ip") || headers.get("x-real-ip") || forwarded || "unknown";
}

export async function hashAddress(secret: string, address: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:${address}`));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Server key: explicit secret, legacy service-role key, or the runtime's JSON key map. */
export function resolveServerKey(env: { get(name: string): string | undefined }): string {
  const direct = env.get("SUPABASE_SECRET_KEY") || env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  try {
    const keys = JSON.parse(env.get("SUPABASE_SECRET_KEYS") || "{}") as Record<string, string>;
    return keys.default || Object.values(keys)[0] || "";
  } catch {
    return "";
  }
}
