// Public, unauthenticated student check-in (verify_jwt = false in supabase/config.toml).
// Protection: origin allow-list, strict input validation, a signed per-scan ticket
// (issued by begin_checkin), rate limits, and a service-role-only SQL function.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  clientAddress,
  hashAddress,
  normalizeOrigin,
  parseAllowedOrigins,
  parseCheckInBody,
  resolveServerKey,
} from "./lib.ts";

const corsHeaders = (origin: string) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "600",
  "Vary": "Origin",
});
const jsonResponse = (payload: Record<string, unknown>, status: number, origin: string) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

Deno.serve(async (request) => {
  const allowedOrigins = parseAllowedOrigins(Deno.env.get("ALLOWED_ORIGIN"));
  const requestOrigin = normalizeOrigin(request.headers.get("origin"));
  const originAllowed = Boolean(requestOrigin && allowedOrigins.includes(requestOrigin));
  const responseOrigin = originAllowed ? requestOrigin : allowedOrigins[0] || requestOrigin || "null";

  // Not configured: let the preflight pass so the POST can return a readable
  // configuration error. Check-in stays disabled until ALLOWED_ORIGIN is set.
  if (!allowedOrigins.length) {
    console.error("[check-in] ALLOWED_ORIGIN is not configured");
    if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(responseOrigin) });
    return jsonResponse({ ok: false, code: "server_not_configured" }, 503, responseOrigin);
  }
  if (requestOrigin && !originAllowed) {
    console.warn("[check-in] Rejected origin", { origin: requestOrigin });
    return jsonResponse({ ok: false, code: "origin_not_allowed" }, 403, responseOrigin);
  }
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(responseOrigin) });
  if (request.method !== "POST") return jsonResponse({ ok: false, code: "method_not_allowed" }, 405, responseOrigin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serverKey = resolveServerKey(Deno.env);
  const rateLimitSecret = Deno.env.get("RATE_LIMIT_SECRET");
  if (!supabaseUrl || !serverKey || !rateLimitSecret) {
    console.error("[check-in] Server secrets are incomplete", {
      hasSupabaseUrl: Boolean(supabaseUrl),
      hasServerKey: Boolean(serverKey),
      hasRateLimitSecret: Boolean(rateLimitSecret),
    });
    return jsonResponse({ ok: false, code: "server_not_configured" }, 503, responseOrigin);
  }

  let input;
  try {
    input = parseCheckInBody(await request.json());
  } catch {
    input = null;
  }
  if (!input) return jsonResponse({ ok: false, code: "invalid_request" }, 400, responseOrigin);

  const ipHash = await hashAddress(rateLimitSecret, clientAddress(request.headers));
  const client = createClient(supabaseUrl, serverKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.rpc("check_in_secure", {
    p_ticket: input.ticket,
    p_full_name: input.fullName,
    p_study_program_id: input.programId,
    p_ip_hash: ipHash,
  });
  if (error) {
    // Never return database details to an unauthenticated caller.
    console.error("[check-in] check_in_secure failed", error.message);
    return jsonResponse({ ok: false, code: "server_error" }, 500, responseOrigin);
  }
  const result = data && typeof data === "object" ? (data as Record<string, unknown>) : { ok: false, code: "server_error" };
  // Business outcomes (duplicate, closed, expired, …) are HTTP 200 so the page can
  // show the specific message; transport/configuration failures use 4xx/5xx.
  return jsonResponse(result, 200, responseOrigin);
});
