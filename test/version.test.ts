import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VERSION } from '../src/check.ts';

const readJson = (name: string): unknown => JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));

test('the version is the same in the source, package.json and the lockfile', () => {
  const pkg = readJson('package.json') as { version: string };
  const lock = readJson('package-lock.json') as { version: string; packages: Record<string, { version?: string }> };
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, VERSION);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages['']?.version, VERSION);
});
