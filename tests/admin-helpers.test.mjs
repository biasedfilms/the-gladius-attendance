import test from "node:test";
import assert from "node:assert/strict";
import { adminErrorMessage } from "../js/admin-errors.js";
import { buildCheckInUrl, isLoopbackHost, parseCheckInParams } from "../js/checkin-link.js";
import { findPossibleDuplicates, normalizeName } from "../js/duplicates.js";

const MEETING = "c0000000-0000-4000-8000-000000000002";

test("normalizeName mirrors the database normalisation", () => {
  // Same cases as tests/sql/10_attendance.test.sql.
  assert.equal(normalizeName("  Budi-Santoso.  "), "budi santoso");
  assert.equal(normalizeName("O'Neil  (Nil)"), "oneil nil");
  assert.equal(normalizeName(".."), "");
});

test("builds rotating and static check-in links", () => {
  const rotating = buildCheckInUrl({ m: MEETING, c: "119600000.0123456789abcdef0123" }, "https://app.example/admin.html?x=1#top");
  assert.equal(rotating.href, `https://app.example/check-in.html?m=${MEETING}&c=119600000.0123456789abcdef0123`);
  const staticLink = buildCheckInUrl({ token: "a".repeat(64) }, "https://app.example/admin.html");
  assert.equal(staticLink.searchParams.get("token"), "a".repeat(64));
});

test("honours a configured check-in base URL", () => {
  const params = { m: MEETING, c: "1.0123456789abcdef0123" };
  assert.equal(buildCheckInUrl(params, "http://localhost:3000/admin.html", "http://192.168.1.41:3000").pathname, "/check-in.html");
  assert.equal(buildCheckInUrl(params, "http://localhost/admin.html", "https://x.example/app/check-in.html").pathname, "/app/check-in.html");
  assert.equal(buildCheckInUrl(params, "http://localhost/admin.html", "https://x.example/app").pathname, "/app/check-in.html");
});

test("parses check-in links and rejects incomplete ones", () => {
  assert.deepEqual(parseCheckInParams(`?m=${MEETING.toUpperCase()}&c=12.0123456789abcdef0123`), { kind: "rotating", meetingId: MEETING, code: "12.0123456789abcdef0123" });
  assert.deepEqual(parseCheckInParams(`?token=${"b".repeat(64)}`), { kind: "static", token: "b".repeat(64) });
  assert.equal(parseCheckInParams(`?m=${MEETING}`), null);
  assert.equal(parseCheckInParams(`?m=${MEETING}&c=nope`), null);
  assert.equal(parseCheckInParams("?token=short"), null);
  assert.equal(parseCheckInParams(""), null);
});

test("detects loopback hosts that phones cannot reach", () => {
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("192.168.1.41"), false);
});

test("flags possible duplicates within the same meeting only", () => {
  const rows = [
    { id: "1", meeting_id: "m1", full_name: "Budi Santoso", study_program_id: "p1" },
    { id: "2", meeting_id: "m1", full_name: "Budi S.", study_program_id: "p1" },
    { id: "3", meeting_id: "m1", full_name: "Sari Dewi", study_program_id: "p1" },
    { id: "4", meeting_id: "m1", full_name: "sari dewi", study_program_id: "p2" },
    { id: "5", meeting_id: "m2", full_name: "Budi", study_program_id: "p1" },
    { id: "6", meeting_id: "m1", full_name: "Budiman", study_program_id: "p1" },
    { id: "7", meeting_id: "m1", full_name: "Andi Wijaya", study_program_id: "p1" },
    { id: "8", meeting_id: "m1", full_name: "Peserta 1", study_program_id: "p1" },
    { id: "9", meeting_id: "m1", full_name: "Peserta 10", study_program_id: "p1" },
  ];
  const flags = findPossibleDuplicates(rows);
  assert.match(flags.get("1"), /Budi S\./);
  assert.match(flags.get("2"), /Budi Santoso/);
  assert.match(flags.get("3"), /program studi lain/);
  assert.match(flags.get("4"), /program studi lain/);
  assert.equal(flags.has("5"), false, "other meeting is not compared");
  assert.equal(flags.has("6"), false, "different first name is not a duplicate");
  assert.equal(flags.has("7"), false);
  assert.equal(flags.has("8") || flags.has("9"), false, "digits are not initials");
});

test("maps admin database errors to Indonesian messages", () => {
  assert.match(adminErrorMessage({ message: "invalid_state_transition" }, "x"), /Status sesi sudah berubah/);
  assert.match(adminErrorMessage({ message: "already_recorded" }, "x"), /sudah tercatat/);
  assert.match(adminErrorMessage({ code: "PGRST202", message: "Could not find the function" }, "x"), /migrasi/);
  assert.equal(adminErrorMessage({ message: "something else" }, "fallback"), "fallback");
});
