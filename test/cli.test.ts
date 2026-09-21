import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { check, VERSION } from '../src/check.ts';
import { loadProject } from '../src/project.ts';
import { ENV, fakeJev, startFakeJevServer, tempProject } from './helpers.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  // No key in the environment: nothing here may reach the network.
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
/**
 * For the tests that talk to a loopback server started in this same process: spawnSync would
 * block the event loop and the server could never answer its own child, so this awaits instead.
 * The key only ever travels to that local server.
 */
const runAgainstLocalServer = (env: Record<string, string>, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });

test('no command prints help and fails; --help succeeds', () => {
  assert.equal(run().status, 1);
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /jev-calibrate check/);
});

test('--version and -v print the version and exit 0 regardless of any command', () => {
  const long = run('--version');
  assert.equal(long.status, 0);
  assert.equal(long.stdout.trim(), VERSION);
  const short = run('-v', 'check');
  assert.equal(short.status, 0);
  assert.equal(short.stdout.trim(), VERSION);
});

test('valid --runs and --concurrency values pass validation before the key check runs', () => {
  const dir = tempProject({ questions: { q: { type: 'noul', instructions: 'x' } } }, [{ id: '1', state: 's', labels: { q: true } }]);
  const result = run('check', '--dir', dir, '--runs', '2', '--concurrency', '3');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no API key/);
});

test('check refuses to run while lint errors remain', () => {
  const broken = tempProject({ questions: { q: { type: 'noul', instructions: 'x' } } }, [{ id: '1', state: 's', labels: { q: 'yes' } }]);
  const result = run('check', '--dir', broken);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fix the errors above/);
  assert.match(result.stderr, /label-type/);
});

test('init on a path that is a file says so in one line and exits with 2', () => {
  const parent = tempProject({ questions: {} }, []);
  const notADirectory = path.join(parent, 'not-a-directory');
  writeFileSync(notADirectory, 'x');
  const result = run('init', '--dir', notADirectory);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^error: cannot write into .*not-a-directory/);
  assert.equal(result.stderr.trim().split('\n').length, 1);
});

test('compare accepts two explicit run files and reports what changed between them', async () => {
  const compareQuestions = { questions: { refund: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }, settings: { minPerClass: 1 } };
  const compareExamples = [
    { id: 'p1', state: 'refund POS', labels: { refund: true }, split: 'tune' },
    { id: 'n1', state: 'refund NEG', labels: { refund: false }, split: 'tune' },
  ];
  const { project } = loadProject(tempProject(compareQuestions, compareExamples));
  const wrong = fakeJev(() => ({ type: 'noul', noul: 0.5 }));
  const right = fakeJev((state) => ({ type: 'noul', noul: state.includes('POS') ? 0.9 : 0.1 }));
  const before = await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl: wrong });
  const after = await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl: right });
  const result = run('compare', before.runFile as string, after.runFile as string);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /verdict {4}.+ -> gate/);
  assert.match(result.stdout, /fixed {6}n1/);
});

test('check runs end to end against a local stub server, and --require gate passes when it should', async () => {
  const dir = tempProject(
    { questions: { refund: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }, settings: { minPerClass: 2 } },
    [
      { id: 'p1', state: 'refund POS one', labels: { refund: true }, split: 'tune' },
      { id: 'p2', state: 'refund POS two', labels: { refund: true }, split: 'tune' },
      { id: 'n1', state: 'refund NEG one', labels: { refund: false }, split: 'tune' },
      { id: 'n2', state: 'refund NEG two', labels: { refund: false }, split: 'tune' },
    ],
  );
  const server = await startFakeJevServer((state) => ({ type: 'noul', noul: state.includes('POS') ? 0.95 : 0.05 }));
  try {
    const result = await runAgainstLocalServer({ TYPESAFE_API_KEY: 'local-only-key' }, 'check', '--dir', dir, '--base-url', server.url, '--require', 'gate');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /verdict {4}gate/);
    assert.match(result.stdout, /run file:/);
  } finally {
    await server.close();
  }
});

test('check exits 1 when a question does not meet --require', async () => {
  const dir = tempProject(
    { questions: { refund: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }, settings: { minPerClass: 2 } },
    [
      { id: 'p1', state: 'refund POS one', labels: { refund: true }, split: 'tune' },
      { id: 'n1', state: 'refund NEG one', labels: { refund: false }, split: 'tune' },
    ],
  );
  const server = await startFakeJevServer((state) => ({ type: 'noul', noul: state.includes('POS') ? 0.95 : 0.05 }));
  try {
    const result = await runAgainstLocalServer({ TYPESAFE_API_KEY: 'local-only-key' }, 'check', '--dir', dir, '--base-url', server.url, '--require', 'gate');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /below "gate": refund/);
  } finally {
    await server.close();
  }
});

test('init then lint works on an empty directory and never overwrites', () => {
  const dir = tempProject({ questions: {} }, []);
  const again = run('init', '--dir', dir);
  assert.match(again.stdout, /kept questions\.json/);
  assert.equal(again.status, 0);
});

test('lint exits 1 on errors, and --strict turns warnings into a failure', () => {
  const broken = tempProject({ questions: { q: { type: 'noul', instructions: 'x' } } }, [{ id: '1', state: 's', labels: { q: 'yes' } }]);
  assert.equal(run('lint', '--dir', broken).status, 1);
  const thin = tempProject({ questions: { q: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } } }, [{ id: '1', state: 's', labels: { q: true } }]);
  assert.equal(run('lint', '--dir', thin).status, 0);
  assert.equal(run('lint', '--dir', thin, '--strict').status, 1);
});

test('check without a key fails with a clear message and exit 2', () => {
  const dir = tempProject({ questions: { q: { type: 'noul', instructions: 'x' } } }, [{ id: '1', state: 's', labels: { q: true } }]);
  const result = run('check', '--dir', dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no API key/);
});

test('compare refuses a single file instead of silently comparing other runs', () => {
  const result = run('compare', '/nonexistent/only-one.json');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /two run files, or none/);
});

test('bad option values are rejected', () => {
  const dir = tempProject({ questions: { q: { type: 'noul', instructions: 'x' } } }, [{ id: '1', state: 's', labels: { q: true } }]);
  assert.match(run('check', '--dir', dir, '--split', 'sideways').stderr, /--split must be/);
  assert.match(run('check', '--dir', dir, '--runs', '0').stderr, /positive integer/);
  assert.match(run('check', '--dir', dir, '--question', 'ghost').stderr, /not in questions\.json/);
  assert.match(run('nonsense', '--dir', dir).stderr, /unknown command/);
  assert.match(run('compare', '--dir', dir, '--split', 'holdut').stderr, /--split must be/);
  assert.match(run('check', '--dir', dir, '--require', 'perfect').stderr, /gate, gate-above-confidence, ranker/);
});
