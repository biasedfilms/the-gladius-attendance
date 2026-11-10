import test from 'node:test';
import assert from 'node:assert/strict';
import { beginFailureMessage, checkInFailureMessage, functionCodeMessage } from '../js/check-in-errors.js';

globalThis.location = { origin: 'https://the-gladius-attendance.vercel.app' };
const originalConsoleError = console.error;
test.before(() => { console.error = () => {}; });
test.after(() => { console.error = originalConsoleError; });

test('reports a missing/misconfigured server secret using the safe response code', async () => {
  const error = {
    name: 'FunctionsHttpError',
    message: 'Edge Function returned a non-2xx status code',
    context: new Response(JSON.stringify({ ok: false, code: 'server_not_configured' }), { status: 503 }),
  };
  assert.match(await checkInFailureMessage(error), /belum dikonfigurasi di Supabase/);
});

test('identifies an unknown or undeployed function', async () => {
  const error = { name: 'FunctionsHttpError', message: 'not found', context: new Response('{}', { status: 404 }) };
  assert.match(await checkInFailureMessage(error), /Edge Function bernama check-in sudah di-deploy/);
});

test('explains likely CORS/origin issue for a fetch failure without leaking student data', async () => {
  const error = { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' };
  const result = await checkInFailureMessage(error);
  assert.match(result, /CORS/);
  assert.match(result, /https:\/\/the-gladius-attendance\.vercel\.app/);
  assert.match(result, /belum dapat dipastikan/);
  // Retrying is safe: a record that was already saved comes back as "already recorded".
  assert.match(result, /Coba kirim lagi/);
  assert.match(result, /sudah tercatat/);
  assert.doesNotMatch(result, /Mikael|token/i);
});

test('maps origin rejection to the current site origin', () => {
  assert.match(functionCodeMessage('origin_not_allowed'), /https:\/\/the-gladius-attendance\.vercel\.app/);
});

test('preserves rate-limit guidance for HTTP 429', async () => {
  const error = { name: 'FunctionsHttpError', message: 'too many requests', context: new Response('{}', { status: 429 }) };
  assert.match(await checkInFailureMessage(error), /Terlalu banyak percobaan/);
});

test('explains ticket and rotating-QR outcomes with a rescan instruction', () => {
  for (const code of ['ticket_expired', 'session_invalid', 'rate_limited']) {
    assert.match(functionCodeMessage(code), /Scan ulang QR/, code);
  }
  assert.match(beginFailureMessage('code_expired')[1], /15 detik/);
  assert.match(beginFailureMessage('rotating_required')[0], /tidak berlaku/);
  assert.deepEqual(beginFailureMessage('something-new'), beginFailureMessage('invalid'));
});

test('reports a database that has not been migrated yet', async () => {
  const error = { name: 'PostgrestError', code: 'PGRST202', message: 'Could not find the function public.begin_checkin' };
  assert.match(await checkInFailureMessage(error), /sedang diperbarui/);
});
