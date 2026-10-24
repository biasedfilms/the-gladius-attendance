import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInFailureMessage, functionCodeMessage } from '../js/check-in-errors.js';

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
  assert.doesNotMatch(result, /Mikael|token/i);
});

test('maps origin rejection to the current site origin', () => {
  assert.match(functionCodeMessage('origin_not_allowed'), /https:\/\/the-gladius-attendance\.vercel\.app/);
});

test('preserves rate-limit guidance for HTTP 429', async () => {
  const error = { name: 'FunctionsHttpError', message: 'too many requests', context: new Response('{}', { status: 429 }) };
  assert.match(await checkInFailureMessage(error), /Terlalu banyak percobaan/);
});
