import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
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

/** The same stand-in over HTTP on 127.0.0.1, for tests that run the CLI as a subprocess and so cannot pass a FetchLike. */
export async function startFakeJevServer(
  answer: (state: string, id: string, question: Question) => unknown,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { state: string; questions: Record<string, Question> };
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, answer(body.state, id, question)]));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ model: 'fake-http-build', answers, usage: { input_tokens: 50 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
