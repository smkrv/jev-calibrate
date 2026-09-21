import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { lintProject } from '../src/lint.ts';
import { loadProject, ProjectError } from '../src/project.ts';
import { tempProject } from './helpers.ts';

const noul = { type: 'noul', instructions: 'The customer asks for money back.', criteria: { true: 'Asks for a refund.', false: 'Does not.' } };
const codes = (dir: string): string[] => {
  const { project, issues } = loadProject(dir);
  return [...issues, ...lintProject(project)].map((issue) => `${issue.level}:${issue.code}`);
};
const many = (n: number, label: boolean, prefix: string): unknown[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, state: `${prefix} message number ${i}`, labels: { q: label }, split: i % 2 ? 'tune' : 'holdout' }));

test('a healthy project has no issues', () => {
  const dir = tempProject({ questions: { q: noul } }, [...many(10, true, 'yes'), ...many(10, false, 'no')]);
  assert.deepEqual(codes(dir), []);
});

test('missing or broken top-level files throw', () => {
  assert.throws(() => loadProject('/nonexistent-jev-calibrate-dir'), ProjectError);
  const dir = tempProject({ nope: 1 }, []);
  assert.throws(() => loadProject(dir), /"questions" map/);
});

test('bad lines are reported with their line number and do not hide good ones', () => {
  const dir = tempProject({ questions: { q: noul } }, []);
  writeFileSync(path.join(dir, 'examples.jsonl'), '{"id":"ok","state":"fine","labels":{"q":true}}\nnot json\n{"id":"","state":"x","labels":{"q":true}}\n');
  const { project, issues } = loadProject(dir);
  assert.equal(project.examples.length, 1);
  assert.deepEqual(issues.map((issue) => issue.where), ['examples.jsonl:2', 'examples.jsonl:3']);
});

test('question shapes are validated', () => {
  const dir = tempProject(
    {
      questions: {
        a: { type: 'choice', instructions: 'x', criteria: { only: 'one' } },
        b: { type: 'score', instructions: 'x', criteria: ['one'] },
        c: { type: 'guess', instructions: 'x' },
        d: { type: 'noul', instructions: ' ' },
        e: { type: 'noul', instructions: 'x', criteria: { true: 'a' } },
        f: { type: 'noul', instructions: 'x', criteria: 'not an object' },
      },
    },
    [{ id: '1', state: 's', labels: { a: 'only' } }],
  );
  const { project, issues } = loadProject(dir);
  assert.equal(Object.keys(project.questions).length, 0);
  const shapeIssues = issues.filter((issue) => issue.code === 'question-shape');
  assert.equal(shapeIssues.length, 6);
  assert.equal(shapeIssues.filter((issue) => /noul "criteria" must be an object/.test(issue.message)).length, 2);
});

test('decision shapes are validated', () => {
  const dir = tempProject(
    { questions: { q: noul }, decisions: { q: { threshold: 1.5, minConfidence: -0.2 }, bogus: 'not an object' } },
    [{ id: '1', state: 'one', labels: { q: true } }],
  );
  const { project, issues } = loadProject(dir);
  assert.deepEqual(project.decisions.q, {});
  assert.equal(Object.hasOwn(project.decisions, 'bogus'), false);
  const shapeIssues = issues.filter((issue) => issue.code === 'decision-shape');
  assert.equal(shapeIssues.length, 3);
  assert.ok(shapeIssues.some((issue) => /"threshold" must be a number from 0 to 1/.test(issue.message)));
  assert.ok(shapeIssues.some((issue) => /"minConfidence" must be a number from 0 to 1/.test(issue.message)));
  assert.ok(shapeIssues.some((issue) => /a decision must be an object/.test(issue.message)));
});

test('settings sub-fields are validated one by one, each falling back to its default', () => {
  const dir = tempProject(
    { questions: { q: noul }, settings: { model: '', holdoutFraction: 1, minPerClass: 0 } },
    [{ id: '1', state: 'one', labels: { q: true } }],
  );
  const { project, issues } = loadProject(dir);
  const shapeIssues = issues.filter((issue) => issue.code === 'settings-shape');
  assert.equal(shapeIssues.length, 3);
  assert.ok(shapeIssues.some((issue) => /"model" must be a non-empty string/.test(issue.message)));
  assert.ok(shapeIssues.some((issue) => /"holdoutFraction" must be a number between 0 and 1/.test(issue.message)));
  assert.ok(shapeIssues.some((issue) => /"minPerClass" must be a positive integer/.test(issue.message)));
  assert.equal(project.settings.model, undefined);
  assert.equal(project.settings.holdoutFraction, 0.5);
  assert.equal(project.settings.minPerClass, 5);
});

test('a non-object settings value is refused and defaults are kept', () => {
  const dir = tempProject({ questions: { q: noul }, settings: 'not an object' }, [{ id: '1', state: 'one', labels: { q: true } }]);
  const { project, issues } = loadProject(dir);
  const shapeIssues = issues.filter((issue) => issue.code === 'settings-shape');
  assert.deepEqual(shapeIssues.map((issue) => issue.message), ['"settings" must be an object']);
  assert.equal(project.settings.holdoutFraction, 0.5);
  assert.equal(project.settings.minPerClass, 5);
});

test('an example needs at least one label, and a label must be a boolean, string or number', () => {
  const dir = tempProject({ questions: { q: noul } }, []);
  const lines = [
    '{"id":"empty","state":"x","labels":{}}',
    '{"id":"array-label","state":"x","labels":{"q":[1,2]}}',
    '{"id":"object-label","state":"x","labels":{"q":{}}}',
    '{"id":"null-label","state":"x","labels":{"q":null}}',
  ];
  writeFileSync(path.join(dir, 'examples.jsonl'), lines.join('\n'));
  const { project, issues } = loadProject(dir);
  assert.equal(project.examples.length, 0);
  const shapeIssues = issues.filter((issue) => issue.code === 'example-shape');
  assert.equal(shapeIssues.length, 4);
  assert.match(shapeIssues[0]?.message ?? '', /must map at least one question id/);
  assert.ok(shapeIssues.slice(1).every((issue) => /must be a boolean, a string or a number/.test(issue.message)));
});

test('a missing examples.jsonl throws instead of treating the project as empty', () => {
  const dir = tempProject({ questions: { q: noul } }, []);
  unlinkSync(path.join(dir, 'examples.jsonl'));
  assert.throws(() => loadProject(dir), /cannot read .*examples\.jsonl/);
});

test('state_file is read from inside the project and refused outside it, symlinks included', () => {
  const dir = tempProject({ questions: { q: noul } }, []);
  const outside = tempProject({ questions: {} }, []);
  writeFileSync(path.join(outside, 'secret.txt'), 'SECRET=do-not-send');
  mkdirSync(path.join(dir, 'states'));
  writeFileSync(path.join(dir, 'states', 'one.txt'), 'A long message kept in its own file.');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
  symlinkSync(outside, path.join(dir, 'linked-dir'));
  const lines = [
    { id: 'in', state_file: 'states/one.txt', labels: { q: false } },
    { id: 'dots', state_file: path.relative(dir, path.join(outside, 'secret.txt')), labels: { q: false } },
    { id: 'absolute', state_file: path.join(outside, 'secret.txt'), labels: { q: false } },
    { id: 'file-link', state_file: 'link.txt', labels: { q: false } },
    { id: 'dir-link', state_file: 'linked-dir/secret.txt', labels: { q: false } },
    { id: 'missing', state_file: 'states/nope.txt', labels: { q: false } },
  ];
  writeFileSync(path.join(dir, 'examples.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));
  const { project, issues } = loadProject(dir);
  assert.deepEqual(project.examples.map((example) => example.id), ['in']);
  assert.equal(project.examples[0]?.state, 'A long message kept in its own file.');
  assert.equal(issues.filter((issue) => /outside the project directory/.test(issue.message)).length, 4);
  assert.equal(issues.filter((issue) => /cannot be read/.test(issue.message)).length, 1);
  assert.ok(!JSON.stringify(project).includes('do-not-send'));
});

test('names that would reach Object.prototype are refused everywhere', () => {
  const dir = tempProject(
    { questions: { constructor: noul, c: { type: 'choice', instructions: 'x', criteria: { __proto__: 'x', other: 'rest' } }, ok: { type: 'choice', instructions: 'x', criteria: { entries: 'A', other: 'rest' } } } },
    [
      { id: '1', state: 'one', labels: { ok: 'constructor' } },
      { id: '2', state: 'two', labels: { ok: 'toString' } },
      { id: '3', state: 'three', labels: { constructor: true } },
    ],
  );
  const { project, issues } = loadProject(dir);
  assert.deepEqual(Object.keys(project.questions), ['ok']);
  const all = [...issues, ...lintProject(project)];
  assert.equal(all.filter((issue) => issue.code === 'label-type').length, 2);
  assert.ok(all.some((issue) => /reserved/.test(issue.message)));
  assert.equal(typeof Object.entries, 'function');
  assert.equal(({} as Record<string, unknown>).other, undefined);
});

test('inherited Object.prototype names are refused as well', () => {
  const dir = tempProject(
    { questions: { toString: noul, c: { type: 'choice', instructions: 'x', criteria: { valueOf: 'x', other: 'rest' } }, q: noul } },
    [{ id: '1', state: 'one', labels: { q: true, hasOwnProperty: true } }],
  );
  const { project, issues } = loadProject(dir);
  assert.deepEqual(Object.keys(project.questions), ['q']);
  assert.equal(issues.filter((issue) => /reserved/.test(issue.message)).length, 3);
});

test('labels must match the question type', () => {
  const dir = tempProject(
    { questions: { q: noul, c: { type: 'choice', instructions: 'x', criteria: { a: 'A', other: 'rest' } }, s: { type: 'score', instructions: 'x', criteria: ['low', 'high'] } } },
    [
      { id: '1', state: 'one', labels: { q: 'yes' } },
      { id: '2', state: 'two', labels: { c: 'b' } },
      { id: '3', state: 'three', labels: { s: 2 } },
      { id: '4', state: 'four', labels: { ghost: true } },
      { id: '4', state: 'five', labels: { s: 1 } },
    ],
  );
  const found = codes(dir);
  assert.equal(found.filter((code) => code === 'error:label-type').length, 3);
  assert.ok(found.includes('error:unknown-question'));
  assert.ok(found.includes('error:duplicate-id'));
});

test('a choice without a way out is flagged; a configured escape name clears it', () => {
  const choice = { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Money.', technical: 'Bugs.' } };
  const examples = [{ id: '1', state: 'an invoice question', labels: { c: 'billing' } }];
  assert.ok(codes(tempProject({ questions: { c: choice } }, examples)).includes('warning:no-escape-option'));
  const cleared = codes(tempProject({ questions: { c: choice }, settings: { escapeOptions: ['technical'] } }, examples));
  assert.ok(!cleared.includes('warning:no-escape-option'));
});

test('text copied from an example into the criteria is reported as a leak', () => {
  const leaky = { type: 'noul', instructions: 'Refund?', criteria: { true: 'Such as: I want that money back right now.', false: 'Anything else.' } };
  const dir = tempProject({ questions: { q: leaky } }, [{ id: 'copied', state: 'You charged me twice. I want that money back right now!', labels: { q: true } }]);
  const { project } = loadProject(dir);
  const leak = lintProject(project).find((issue) => issue.code === 'example-leak');
  assert.match(leak?.message ?? '', /copied/);
});

test('thin classes, conflicting labels, unused decisions and divided groups are reported', () => {
  const dir = tempProject(
    { questions: { q: noul }, decisions: { q: { minConfidence: 0.7 }, ghost: { threshold: 0.4 } } },
    [
      { id: '1', state: 'Same text.', labels: { q: true }, group: 'g', split: 'tune' },
      { id: '2', state: 'same   TEXT', labels: { q: false }, group: 'g', split: 'holdout' },
    ],
  );
  const found = codes(dir);
  for (const expected of ['warning:few-examples', 'warning:conflicting-labels', 'warning:decision-unused', 'error:unknown-question', 'error:group-split']) {
    assert.ok(found.includes(expected), `missing ${expected} in ${found.join(' ')}`);
  }
});
