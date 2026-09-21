import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, revisionOf } from '../src/hash.ts';
import { selectSplit, splitOf } from '../src/split.ts';
import type { Example } from '../src/types.ts';

const ex = (id: string, extra: Partial<Example> = {}): Example => ({ id, state: 's', labels: { q: true }, ...extra });

test('a split assignment is stable and does not depend on the other examples', () => {
  const first = splitOf(ex('t-1'), 0.5);
  assert.equal(splitOf(ex('t-1'), 0.5), first);
  const many = Array.from({ length: 200 }, (_, i) => ex(`id-${i}`));
  const holdout = selectSplit(many, 0.5, 'holdout').length;
  assert.ok(holdout > 70 && holdout < 130, `expected about half in holdout, got ${holdout}`);
  assert.equal(selectSplit(many, 0.5, 'all').length, 200);
});

test('grouped examples stay together, and an explicit split wins', () => {
  for (let i = 0; i < 40; i += 1) {
    assert.equal(splitOf(ex(`a-${i}`, { group: `g-${i}` }), 0.5), splitOf(ex(`b-${i}`, { group: `g-${i}` }), 0.5));
  }
  const natural = splitOf(ex('x'), 0.5);
  const forced = natural === 'tune' ? 'holdout' : 'tune';
  assert.equal(splitOf(ex('x', { split: forced }), 0.5), forced);
});

test('canonicalJson ignores key order; revisionOf changes with criteria and with the decision', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 1, c: 2 } }), canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
  const q = { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } };
  const base = revisionOf(q, {});
  assert.equal(revisionOf({ ...q }, undefined), base);
  assert.notEqual(revisionOf({ ...q, criteria: { true: 'a2', false: 'b' } }, {}), base);
  assert.notEqual(revisionOf(q, { threshold: 0.6 }), base);
});
