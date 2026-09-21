import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FetchLike } from '../src/client.ts';
import type { Question } from '../src/types.ts';

export function tempProject(questions: unknown, examples: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jev-calibrate-'));
  writeFileSync(path.join(dir, 'questions.json'), JSON.stringify(questions));
  writeFileSync(path.join(dir, 'examples.jsonl'), examples.map((example) => JSON.stringify(example)).join('\n'));
  return dir;
}

/** A stand-in for the API: answers every question from a function of the state. */
export function fakeJev(answer: (state: string, id: string, question: Question) => unknown): FetchLike & { calls: number } {
  const impl = (async (_url: string, init: RequestInit) => {
    impl.calls += 1;
    const body = JSON.parse(String(init.body)) as { state: string; questions: Record<string, Question> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(body.state, id, question)]));
    return new Response(JSON.stringify({ model: 'fake-build', answers, usage: { input_tokens: 100 } }), { status: 200 });
  }) as FetchLike & { calls: number };
  impl.calls = 0;
  return impl;
}

export const ENV = { TYPESAFE_API_KEY: 'test-key-never-sent-anywhere' };
