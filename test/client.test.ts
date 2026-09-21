import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask, isPlainRemote, JevError, parseAnswer, resolveProvider } from '../src/client.ts';
import type { FetchLike } from '../src/client.ts';
import type { Question } from '../src/types.ts';

const noul: Question = { type: 'noul', instructions: 'x' };
const choice: Question = { type: 'choice', instructions: 'x', criteria: { a: 'A', other: 'rest' } };
const provider = resolveProvider({ TYPESAFE_API_KEY: 'secret-key-value' });
const noSleep = async (): Promise<void> => {};
const ok = (answers: unknown): Response => new Response(JSON.stringify({ model: 'build-1', answers, usage: { input_tokens: 1000 } }), { status: 200 });

test('resolveProvider picks a pinned model and the key that is present', () => {
  assert.equal(provider.name, 'typesafe');
  assert.equal(provider.model, 'jev-1.13.0');
  const router = resolveProvider({ OPENROUTER_API_KEY: 'k' });
  assert.equal(router.endpoint, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(resolveProvider({ TYPESAFE_API_KEY: 'a', OPENROUTER_API_KEY: 'b' }, { provider: 'openrouter' }).name, 'openrouter');
  assert.throws(() => resolveProvider({}), /no API key/);
  assert.throws(() => resolveProvider({ OPENROUTER_API_KEY: 'k' }, { provider: 'typesafe' }), /TYPESAFE_API_KEY/);
});

test('a base URL keeps the API path and must be http(s)', () => {
  const local = resolveProvider({ TYPESAFE_API_KEY: 'k' }, { baseUrl: 'http://127.0.0.1:8080/' });
  assert.equal(local.endpoint, 'http://127.0.0.1:8080/v1/systemone');
  for (const tricky of ['https://host.example#', 'https://host.example?a=1', 'https://host.example/prefix/']) {
    const endpoint = resolveProvider({ TYPESAFE_API_KEY: 'k' }, { baseUrl: tricky }).endpoint;
    assert.ok(endpoint.endsWith('/v1/systemone'), `${tricky} -> ${endpoint}`);
  }
  assert.equal(resolveProvider({ TYPESAFE_API_KEY: 'k' }, { baseUrl: 'https://host.example/prefix/' }).endpoint, 'https://host.example/prefix/v1/systemone');
  assert.equal(isPlainRemote('http://127.0.0.1:8080/v1/systemone'), false);
  assert.equal(isPlainRemote('https://host.example/v1/systemone'), false);
  assert.equal(isPlainRemote('http://host.example/v1/systemone'), true);
  assert.throws(() => resolveProvider({ TYPESAFE_API_KEY: 'k' }, { baseUrl: 'file:///etc/passwd' }), /https/);
  assert.throws(() => resolveProvider({ TYPESAFE_API_KEY: 'k' }, { baseUrl: 'not a url' }), /valid URL/);
});

test('ask sends the key only in the header and reads usage', async () => {
  let seen: RequestInit | undefined;
  const fetchImpl: FetchLike = async (_url, init) => {
    seen = init;
    return ok({ q: { type: 'noul', noul: 0.9 } });
  };
  const result = await ask(provider, 'state text', { q: noul }, fetchImpl, noSleep);
  assert.equal((seen?.headers as Record<string, string>).Authorization, 'Bearer secret-key-value');
  assert.ok(!String(seen?.body).includes('secret-key-value'));
  assert.deepEqual(result.answers.q, { type: 'noul', noul: 0.9 });
  assert.equal(result.model, 'build-1');
  assert.ok(Math.abs((result.costUsd ?? 0) - 0.000042) < 1e-12);
});

test('overload is retried, a client error is final and never shows the key', async () => {
  let calls = 0;
  const flaky: FetchLike = async () => {
    calls += 1;
    return calls < 3 ? new Response('busy', { status: 529 }) : ok({ q: { type: 'noul', noul: 0.1 } });
  };
  await ask(provider, 's', { q: noul }, flaky, noSleep);
  assert.equal(calls, 3);

  let denied = 0;
  const unauthorized: FetchLike = async () => {
    denied += 1;
    return new Response('bad key', { status: 401 });
  };
  await assert.rejects(ask(provider, 's', { q: noul }, unauthorized, noSleep), (error: unknown) => {
    assert.ok(error instanceof JevError);
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes('secret-key-value'));
    return true;
  });
  assert.equal(denied, 1);
});

test('a network failure is retried and then reported, not turned into an answer', async () => {
  let calls = 0;
  const down: FetchLike = async () => {
    calls += 1;
    throw new Error('socket hang up');
  };
  await assert.rejects(ask(provider, 's', { q: noul }, down, noSleep), /gave up after 4 attempts/);
  assert.equal(calls, 4);
});

test('an answer is accepted only when it fits its question', () => {
  assert.throws(() => parseAnswer(noul, { type: 'noul', noul: 1.4 }), /probability/);
  assert.throws(() => parseAnswer(noul, undefined), /not an object/);
  assert.throws(() => parseAnswer(choice, { choice: 'ghost', probabilities: { a: 1 }, confidence: 1 }), /not offered/);
  assert.throws(() => parseAnswer(choice, { choice: 'a', confidence: 1 }), /distribution/);
  assert.throws(() => parseAnswer(choice, { choice: 'a', probabilities: {}, confidence: 1 }), /does not match the offered options/);
  assert.throws(() => parseAnswer(choice, { choice: 'a', probabilities: { a: 0.5, ghost: 0.5 }, confidence: 1 }), /does not match/);
  const score: Question = { type: 'score', instructions: 'x', criteria: ['low', 'high'] };
  assert.throws(() => parseAnswer(score, { score: 1.9, probabilities: {}, confidence: 0.8 }), /offered levels/);
  assert.throws(() => parseAnswer(score, { score: 1.9, probabilities: { 7: 1 }, confidence: 0.8 }), /offered levels/);
  const parsed = parseAnswer(choice, { type: 'choice', choice: 'a', probabilities: { a: 0.8, other: 0.2 }, confidence: 0.7, extra: 'ignored' });
  assert.deepEqual(parsed, { type: 'choice', choice: 'a', probabilities: { a: 0.8, other: 0.2 }, confidence: 0.7 });
});

test('a missing or malformed answer fails its own question and leaves the others usable', async () => {
  const partial: FetchLike = async () => ok({ good: { type: 'noul', noul: 0.3 }, __proto__: { type: 'noul', noul: 1 } });
  const result = await ask(provider, 's', { good: noul, missing: noul }, partial, noSleep);
  assert.deepEqual(result.answers, { good: { type: 'noul', noul: 0.3 } });
  assert.match(result.failures.missing ?? '', /not an object/);
});

test('a model name from the server is kept short', async () => {
  const long: FetchLike = async () => new Response(JSON.stringify({ model: 'm'.repeat(5000), answers: { q: { type: 'noul', noul: 0.5 } } }), { status: 200 });
  const result = await ask(provider, 's', { q: noul }, long, noSleep);
  assert.equal(result.model.length, 200);
});
