import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { tempProject } from './helpers.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');
const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  // No key in the environment: nothing here may reach the network.
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

test('no command prints help and fails; --help succeeds', () => {
  assert.equal(run().status, 1);
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /jev-calibrate check/);
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
