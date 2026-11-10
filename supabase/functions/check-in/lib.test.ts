// deno test supabase/functions/check-in/lib.test.ts
import { assertEquals } from "jsr:@std/assert@1.0.13";
import { clientAddress, hashAddress, parseAllowedOrigins, parseCheckInBody, resolveServerKey } from "./lib.ts";

const ticket = "t1.c0000000-0000-4000-8000-000000000002.1794000000.0123456789abcdef.0123456789abcdef0123456789abcdef";
const programId = "b0000000-0000-4000-8000-000000000001";

Deno.test("parses comma-separated origins and strips trailing slashes", () => {
  assertEquals(parseAllowedOrigins(" https://a.example/ , https://b.example,, "), ["https://a.example", "https://b.example"]);
  assertEquals(parseAllowedOrigins(undefined), []);
});

Deno.test("accepts a well-formed check-in body and cleans the name", () => {
  assertEquals(parseCheckInBody({ ticket, full_name: "  Budi   Santoso ", study_program_id: programId.toUpperCase() }), {
    ticket,
    fullName: "Budi Santoso",
    programId,
  });
});

Deno.test("rejects malformed bodies", () => {
  for (const body of [
    null,
    [],
    "x",
    { ticket: "abc", full_name: "Budi", study_program_id: programId },
    { ticket, full_name: "B", study_program_id: programId },
    { ticket, full_name: "x".repeat(101), study_program_id: programId },
    { ticket, full_name: "Budi", study_program_id: "not-a-uuid" },
    { token: "a".repeat(64), full_name: "Budi", study_program_id: programId },
  ]) {
    assertEquals(parseCheckInBody(body), null, JSON.stringify(body));
  }
});

Deno.test("prefers proxy-set client address headers", () => {
  assertEquals(clientAddress(new Headers({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "9.9.9.9" })), "1.1.1.1");
  assertEquals(clientAddress(new Headers({ "x-forwarded-for": "9.9.9.9, 2.2.2.2" })), "2.2.2.2");
  assertEquals(clientAddress(new Headers()), "unknown");
});

Deno.test("hashes addresses with the secret", async () => {
  const a = await hashAddress("secret", "1.1.1.1");
  assertEquals(a.length, 64);
  assertEquals(a === (await hashAddress("other", "1.1.1.1")), false);
});

Deno.test("resolves the server key from the runtime key map", () => {
  const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] });
  assertEquals(resolveServerKey(env({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}' })), "sb_secret_x");
  assertEquals(resolveServerKey(env({ SUPABASE_SERVICE_ROLE_KEY: "legacy" })), "legacy");
  assertEquals(resolveServerKey(env({ SUPABASE_SECRET_KEYS: "not json" })), "");
});
