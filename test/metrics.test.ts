import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  argmax, auc, averageDistributions, brier, confidentErrors, confusionAt, groupedPairs, reliability, selectiveAt,
  suggestMinConfidence, suggestThreshold,
} from '../src/metrics.ts';
import type { ClassPoint, NoulPoint } from '../src/metrics.ts';
import { DEFAULT_SETTINGS } from '../src/types.ts';

const targets = DEFAULT_SETTINGS.targets;
const point = (id: string, label: boolean, value: number, group?: string): NoulPoint => (group ? { id, label, value, group } : { id, label, value });

test('auc: perfect, inverted, tied, and undefined without both classes', () => {
  assert.equal(auc([point('a', true, 0.9), point('b', false, 0.1)]), 1);
  assert.equal(auc([point('a', true, 0.1), point('b', false, 0.9)]), 0);
  assert.equal(auc([point('a', true, 0.5), point('b', false, 0.5)]), 0.5);
  assert.equal(auc([point('a', true, 0.5)]), undefined);
});

test('confusionAt counts a value equal to the threshold as yes', () => {
  const c = confusionAt([point('a', true, 0.5), point('b', false, 0.5), point('c', false, 0.2), point('d', true, 0.1)], 0.5);
  assert.deepEqual([c.tp, c.fp, c.tn, c.fn], [1, 1, 1, 1]);
  assert.equal(c.precision, 0.5);
  assert.equal(c.recall, 0.5);
  assert.equal(c.falsePositiveRate, 0.5);
});

test('confusionAt leaves precision undefined when nothing is called yes', () => {
  assert.equal(confusionAt([point('a', true, 0.1)], 0.5).precision, undefined);
});

test('suggestThreshold finds the cut that a fixed 0.5 misses', () => {
  // Every probability sits above 0.5: a ranker at 0.5, a gate at the right threshold.
  const points = [point('p1', true, 0.95), point('p2', true, 0.9), point('n1', false, 0.7), point('n2', false, 0.6)];
  assert.equal(confusionAt(points, 0.5).precision, 0.5);
  const suggested = suggestThreshold(points, targets);
  assert.ok(suggested && suggested.threshold > 0.7 && suggested.threshold < 0.9);
  assert.equal(suggested.precision, 1);
  assert.equal(suggested.recall, 1);
});

test('suggestThreshold prefers recall among thresholds that meet the precision target', () => {
  const points = [point('p1', true, 0.9), point('p2', true, 0.4), point('n1', false, 0.2), point('n2', false, 0.1)];
  const suggested = suggestThreshold(points, targets);
  assert.equal(suggested?.recall, 1);
  assert.ok((suggested?.threshold ?? 1) < 0.4);
});

test('groupedPairs compares only inside a group', () => {
  const points = [
    point('a1', true, 0.8, 'a'), point('a2', false, 0.3, 'a'),
    point('b1', true, 0.2, 'b'), point('b2', false, 0.6, 'b'),
    point('loose', false, 0.99),
  ];
  assert.deepEqual(groupedPairs(points), { correct: 1, total: 2 });
});

test('brier and reliability', () => {
  assert.equal(brier([point('a', true, 1), point('b', false, 0)]), 0);
  assert.equal(brier([point('a', true, 0), point('b', false, 1)]), 1);
  const bins = reliability([point('a', true, 0.9), point('b', false, 0.95), point('c', true, 1)], 5);
  assert.equal(bins.length, 5);
  assert.equal(bins[4]?.count, 3);
  assert.ok(Math.abs((bins[4]?.observed ?? 0) - 2 / 3) < 1e-9);
});

const cls = (id: string, label: string, predicted: string, confidence: number): ClassPoint => ({ id, label, predicted, confidence });

test('selectiveAt reports accuracy and coverage above a cutoff', () => {
  const points = [cls('1', 'a', 'a', 0.95), cls('2', 'a', 'b', 0.55), cls('3', 'b', 'b', 0.8), cls('4', 'b', 'a', 0.6)];
  const row = selectiveAt(points, 0.7);
  assert.equal(row.covered, 2);
  assert.equal(row.coverage, 0.5);
  assert.equal(row.accuracy, 1);
});

test('suggestMinConfidence returns the lowest cutoff that reaches the target, or nothing', () => {
  const good = [cls('1', 'a', 'a', 0.95), cls('2', 'a', 'a', 0.9), cls('3', 'b', 'b', 0.85), cls('4', 'b', 'a', 0.55)];
  assert.equal(suggestMinConfidence(good, targets)?.minConfidence, 0.6);
  // Wrong answers at top confidence: no cutoff can save the question.
  const hopeless = [cls('1', 'a', 'b', 0.99), cls('2', 'a', 'a', 0.6), cls('3', 'b', 'a', 0.98)];
  assert.equal(suggestMinConfidence(hopeless, targets), undefined);
});

test('confidentErrors lists wrong answers a cutoff cannot catch', () => {
  assert.deepEqual(confidentErrors([cls('1', 'a', 'b', 0.97), cls('2', 'a', 'b', 0.5)]).map((p) => p.id), ['1']);
});

test('argmax and averageDistributions', () => {
  assert.equal(argmax({ a: 0.2, b: 0.7, c: 0.1 }), 'b');
  assert.equal(argmax({}), undefined);
  assert.deepEqual({ ...averageDistributions([{ a: 1, b: 0 }, { a: 0, b: 1 }]) }, { a: 0.5, b: 0.5 });
});

test('suggestThreshold keeps close neighbours apart', () => {
  const points = [point('p1', true, 0.90002), point('n1', false, 0.90001), point('p2', true, 0.99), point('n2', false, 0.1)];
  const suggested = suggestThreshold(points, targets);
  assert.equal(suggested?.precision, 1);
  assert.equal(suggested?.recall, 1);
});
