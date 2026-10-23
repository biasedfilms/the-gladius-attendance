import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = (origin: string) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const jsonResponse = (payload: Record<string, unknown>, status: number, origin: string) => new Response(JSON.stringify(payload), { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (request) => {
  const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") || "";
  const requestOrigin = request.headers.get("origin") || "";
  // Configure ALLOWED_ORIGIN to the exact deployed website origin. No wildcard CORS in production.
  if (!allowedOrigin || (requestOrigin && requestOrigin !== allowedOrigin)) return jsonResponse({ ok: false, code: "origin_not_allowed" }, 403, allowedOrigin || "null");
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(allowedOrigin) });
  if (request.method !== "POST") return jsonResponse({ ok: false, code: "method_not_allowed" }, 405, allowedOrigin);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  let serviceRoleKey = Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  // Current Supabase runtimes provide a JSON map of named secret keys. The default
  // secret key is preferred; legacy service_role remains a supported fallback.
  if (!serviceRoleKey) {
    try {
      const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}") as Record<string, string>;
      serviceRoleKey = secretKeys.default || Object.values(secretKeys)[0] || "";
    } catch { serviceRoleKey = ""; }
  }
  const rateLimitSecret = Deno.env.get("RATE_LIMIT_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !rateLimitSecret) return jsonResponse({ ok: false, code: "server_not_configured" }, 503, allowedOrigin);

  let parsedBody: unknown;
  try { parsedBody = await request.json(); } catch { return jsonResponse({ ok: false, code: "invalid_request" }, 400, allowedOrigin); }
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) return jsonResponse({ ok: false, code: "invalid_request" }, 400, allowedOrigin);
  const body = parsedBody as Record<string, unknown>;
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const fullName = typeof body.full_name === "string" ? body.full_name.trim().replace(/\s+/g, " ") : "";
  const programId = typeof body.study_program_id === "string" ? body.study_program_id : "";
  if (token.length < 32 || token.length > 160 || fullName.length < 2 || fullName.length > 100 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(programId)) {
    return jsonResponse({ ok: false, code: "invalid_request" }, 400, allowedOrigin);
  }

  const forwarded = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || forwarded || "unknown";
  const input = new TextEncoder().encode(`${rateLimitSecret}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const ipHash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");

  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.rpc("check_in_secure", { p_token: token, p_full_name: fullName, p_study_program_id: programId, p_ip_hash: ipHash });
  if (error) {
    // Avoid returning database details to an unauthenticated caller.
    console.error("check_in_secure failed", error.message);
    return jsonResponse({ ok: false, code: "server_error" }, 500, allowedOrigin);
  }
  const result = data && typeof data === "object" ? data as Record<string, unknown> : { ok: false, code: "server_error" };
  // Business outcomes are returned as JSON with HTTP 200 so the browser can show
  // the specific validation message; transport/configuration failures still use 4xx/5xx.
  return jsonResponse(result, 200, allowedOrigin);
});
