import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { check, latestRuns, readReport } from '../src/check.ts';
import { compareReports, renderComparison } from '../src/compare.ts';
import { holdoutWarnings, readLedger } from '../src/ledger.ts';
import { loadProject } from '../src/project.ts';
import { belowRequirement, buildReport, renderReport } from '../src/report.ts';
import { ENV, fakeJev, tempProject } from './helpers.ts';

const questions = {
  questions: {
    refund: { type: 'noul', instructions: 'Asks for money back.', criteria: { true: 'Asks.', false: 'Does not.' } },
    team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Money.', other: 'Rest.' } },
    mood: { type: 'score', instructions: 'How upset?', criteria: ['Calm.', 'Irritated.', 'Angry.'] },
  },
  settings: { minPerClass: 2 },
};
const examples = (split: 'tune' | 'holdout'): unknown[] => [
  { id: `${split}-r1`, state: 'refund please calm', labels: { refund: true, team: 'billing', mood: 0 }, split, group: `${split}-g` },
  { id: `${split}-r2`, state: 'refund now ANGRY', labels: { refund: true, team: 'billing', mood: 2 }, split },
  { id: `${split}-n1`, state: 'hello calm', labels: { refund: false, team: 'other', mood: 0 }, split, group: `${split}-g` },
  { id: `${split}-n2`, state: 'broken again ANGRY', labels: { refund: false, team: 'other', mood: 2 }, split },
];

/** Answers from keywords in the state: right on everything unless the state says otherwise. */
const keywordJev = (refundWhenNo = 0.05) =>
  fakeJev((state, id) => {
    if (id === 'refund') return { type: 'noul', noul: state.includes('refund') ? 0.95 : refundWhenNo };
    if (id === 'team') {
      const billing = state.includes('refund');
      return { type: 'choice', choice: billing ? 'billing' : 'other', probabilities: billing ? { billing: 0.9, other: 0.1 } : { billing: 0.1, other: 0.9 }, confidence: 0.85 };
    }
    const angry = state.includes('ANGRY');
    return { type: 'score', score: angry ? 1.9 : 0.1, probabilities: angry ? { 0: 0, 1: 0.1, 2: 0.9 } : { 0: 0.9, 1: 0.1, 2: 0 }, confidence: 0.8 };
  });

test('check reports a gate for questions the model gets right, and asks once per example per run', async () => {
  const { project } = loadProject(tempProject(questions, [...examples('tune'), ...examples('holdout')]));
  const fetchImpl = keywordJev();
  const { report } = await check(project, { split: 'tune', runs: 2, env: ENV, fetchImpl, persist: false });
  assert.equal(fetchImpl.calls, 8);
  assert.equal(report.checked, 4);
  assert.deepEqual(report.questions.map((q) => [q.id, q.verdict]), [['refund', 'gate'], ['team', 'gate'], ['mood', 'gate']]);
  const refund = report.questions[0];
  assert.equal(refund?.noul?.auc, 1);
  assert.deepEqual(refund?.noul?.pairs, { correct: 1, total: 1 });
  assert.deepEqual(refund?.stability, { runs: 2, maxRange: 0, flips: 0 });
  assert.equal(report.questions[2]?.classes?.withinOne, 1);
  assert.match(renderReport(report), /refund {2}\[noul]/);
});

test('a question that only orders well is a ranker, and the tune split suggests a threshold', async () => {
  const { project } = loadProject(tempProject(questions, examples('tune')));
  const { report } = await check(project, { split: 'tune', runs: 1, only: ['refund'], env: ENV, fetchImpl: keywordJev(0.7), persist: false });
  const refund = report.questions[0];
  assert.equal(report.questions.length, 1);
  assert.equal(refund?.verdict, 'ranker');
  assert.ok((refund?.noul?.suggested?.threshold ?? 0) > 0.7);
  // The advice must agree with the suggestion printed under it.
  assert.match(refund?.reason ?? '', /set decisions\.refund\.threshold to 0\.8\d and check again/);
  assert.doesNotMatch(refund?.reason ?? '', /do not cut/);
});

test('a question that no threshold can save is told to sort only', async () => {
  // Overlapping values: one negative above one positive.
  const mixed = [
    { id: 'p1', state: 'refund A', labels: { refund: true }, split: 'tune' }, { id: 'p2', state: 'refund B', labels: { refund: true }, split: 'tune' },
    { id: 'p3', state: 'refund C weak', labels: { refund: true }, split: 'tune' }, { id: 'n1', state: 'none D', labels: { refund: false }, split: 'tune' },
    { id: 'n2', state: 'none E', labels: { refund: false }, split: 'tune' }, { id: 'n3', state: 'none F loud', labels: { refund: false }, split: 'tune' },
  ];
  const fetchImpl = fakeJev((state) => ({ type: 'noul', noul: state.includes('weak') ? 0.55 : state.includes('loud') ? 0.6 : state.includes('refund') ? 0.9 : 0.52 }));
  const { project } = loadProject(tempProject({ ...questions, settings: { minPerClass: 2, targets: { auc: 0.8 } } }, mixed));
  const { report } = await check(project, { split: 'tune', runs: 1, only: ['refund'], env: ENV, fetchImpl, persist: false });
  assert.equal(report.questions[0]?.verdict, 'ranker');
  assert.match(report.questions[0]?.reason ?? '', /do not cut on it/);
});

test('the holdout never suggests an operating point', async () => {
  const { project } = loadProject(tempProject(questions, examples('holdout')));
  const { report } = await check(project, { split: 'holdout', runs: 1, env: ENV, fetchImpl: keywordJev(0.7), persist: false });
  assert.equal(report.questions[0]?.noul?.suggested, undefined);
});

test('a failed request leaves the example not checked instead of wrong', async () => {
  const { project } = loadProject(tempProject(questions, examples('tune')));
  const base = keywordJev();
  const failing = (async (url: string, init: RequestInit) =>
    String(init.body).includes('hello calm') ? new Response('bad request', { status: 422 }) : base(url, init)) as typeof base;
  const { report } = await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl: failing, persist: false });
  assert.equal(report.checked, 3);
  assert.deepEqual(report.notChecked.map((entry) => entry.id), ['tune-n1']);
  assert.ok(report.questions.every((q) => q.outcomes.every((outcome) => outcome.id !== 'tune-n1')));
});

test('holdout runs are recorded, and a changed revision on seen examples is called out', async () => {
  const dir = tempProject(questions, [...examples('tune'), ...examples('holdout')]);
  const first = loadProject(dir).project;
  const { runFile } = await check(first, { split: 'holdout', runs: 1, env: ENV, fetchImpl: keywordJev() });
  assert.ok(runFile && existsSync(runFile));
  assert.equal(readLedger(dir).length, 3);

  const same = await check(first, { split: 'holdout', runs: 1, env: ENV, fetchImpl: keywordJev() });
  assert.deepEqual(same.report.warnings, []);

  const edited = loadProject(dir).project;
  edited.decisions.refund = { threshold: 0.6 };
  const { report } = await check(edited, { split: 'holdout', runs: 1, env: ENV, fetchImpl: keywordJev() });
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0] ?? '', /refund: 4 of 4 holdout examples already judged 1 earlier revision/);
  assert.equal(readdirSync(path.join(dir, '.jev-calibrate', 'runs')).length, 3);
});

test('holdoutWarnings counts only reused examples', () => {
  const ledger = [{ at: 't', question: 'q', revision: 'old', model: 'm', seen: ['a', 'b'] }];
  assert.deepEqual(holdoutWarnings(ledger, [{ question: 'q', revision: 'old', seen: ['a', 'b'] }]), []);
  assert.deepEqual(holdoutWarnings(ledger, [{ question: 'q', revision: 'new', seen: ['c', 'd'] }]), []);
  const [warning] = holdoutWarnings(ledger, [{ question: 'q', revision: 'new', seen: ['a', 'c', 'd'] }]);
  assert.match(warning ?? '', /1 of 3 holdout examples.*Fresh examples: 2/);
});

test('compare lists what an edit fixed and what it broke', async () => {
  const dir = tempProject(questions, examples('tune'));
  const { project } = loadProject(dir);
  await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl: keywordJev(0.7) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl: keywordJev(0.05) });
  const files = latestRuns(dir, 'tune');
  assert.ok(files);
  const comparison = compareReports(readReport(files[0]), readReport(files[1]));
  const refund = comparison.questions.find((q) => q.id === 'refund');
  assert.deepEqual(refund?.fixed.sort(), ['tune-n1', 'tune-n2']);
  assert.deepEqual(refund?.regressed, []);
  assert.equal(refund?.after.verdict, 'gate');
  assert.match(renderComparison(comparison), /verdict {4}ranker -> gate/);
  assert.equal(latestRuns(dir, 'holdout'), undefined);
});

test('a class with fewer examples than minPerClass keeps a choice from a verdict, as it does a noul', async () => {
  const lopsided = [
    ...Array.from({ length: 6 }, (_, i) => ({ id: `b-${i}`, state: `refund number ${i}`, labels: { team: 'billing' }, split: 'tune' })),
    { id: 'o-0', state: 'hello there', labels: { team: 'other' }, split: 'tune' },
  ];
  const { project } = loadProject(tempProject(questions, lopsided));
  const { report } = await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl: keywordJev(), persist: false });
  assert.equal(report.questions[0]?.verdict, 'too-few-examples');
  assert.match(report.questions[0]?.reason ?? '', /other: 1/);
});

test('a gate on a class question names the offered classes nobody labelled', async () => {
  const { project } = loadProject(tempProject(questions, examples('tune')));
  const { report } = await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl: keywordJev(), persist: false });
  const reasons = Object.fromEntries(report.questions.map((q) => [q.id, q.reason]));
  assert.match(reasons.mood ?? '', /no labelled examples for 1/);
  assert.doesNotMatch(reasons.team ?? '', /no labelled examples/);
});

test('compare notes two runs that asked a different number of times', async () => {
  const { project } = loadProject(tempProject(questions, examples('tune')));
  const once = await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl: keywordJev(), persist: false });
  const thrice = await check(project, { split: 'tune', runs: 3, env: ENV, fetchImpl: keywordJev(), persist: false });
  assert.deepEqual(compareReports(once.report, thrice.report).notes, ['different numbers of runs: 1 and 3']);
  assert.deepEqual(compareReports(once.report, once.report).notes, []);
});

test('check refuses duplicate example ids instead of merging their answers', async () => {
  const twins = [...examples('tune'), { id: 'tune-r1', state: 'another refund', labels: { refund: true }, split: 'tune' }];
  const { project } = loadProject(tempProject(questions, twins));
  await assert.rejects(check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl: keywordJev(), persist: false }), /duplicate example id "tune-r1"/);
});

test('a report over more examples than a call can take arguments still builds', () => {
  const { project } = loadProject(tempProject({ questions: { refund: questions.questions.refund }, settings: { minPerClass: 2 } }, [{ id: 'seed', state: 's', labels: { refund: true } }]));
  const many = Array.from({ length: 130_002 }, (_, i) => ({ id: `e-${i}`, state: 's', labels: { refund: i < 2 }, split: 'tune' as const }));
  const raw = many.map((example, i) => ({ id: example.id, stateHash: 'x', answers: { refund: [{ type: 'noul' as const, noul: i < 2 ? 0.9 : 0.1 }] } }));
  const report = buildReport(project, many, { examples: raw, requests: raw.length, models: ['m'], seconds: 1 }, { version: 'x', split: 'tune', runs: 1, provider: 'typesafe', model: 'm', warnings: [] });
  assert.equal(report.questions[0]?.verdict, 'gate');
});

test('a question labelled with a single class cannot earn a verdict', async () => {
  const oneClass = Array.from({ length: 10 }, (_, i) => ({ id: `same-${i}`, state: `refund message ${i} calm`, labels: { team: 'billing', mood: 0 }, split: 'tune' }));
  const { project } = loadProject(tempProject(questions, oneClass));
  const { report } = await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl: keywordJev(), persist: false });
  for (const question of report.questions) {
    assert.equal(question.verdict, 'too-few-examples');
    assert.match(question.reason, /single class/);
  }
});

test('one unusable answer costs its own question one example, not every question', async () => {
  const { project } = loadProject(tempProject(questions, examples('tune')));
  const base = keywordJev();
  const broken = fakeJev((state, id, question) => {
    if (id === 'team' && state.includes('hello calm')) return { type: 'choice', choice: 'ghost', probabilities: { billing: 1 }, confidence: 1 };
    return undefined as unknown;
  });
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const good = await (await base(url, init)).json() as { answers: Record<string, unknown> };
    const bad = await (await broken(url, init)).json() as { answers: Record<string, unknown> };
    for (const [id, answer] of Object.entries(bad.answers)) if (answer) good.answers[id] = answer;
    return new Response(JSON.stringify(good), { status: 200 });
  }) as typeof base;
  const { report } = await check(project, { split: 'tune', runs: 2, env: ENV, fetchImpl, persist: false });
  assert.equal(report.checked, 4);
  assert.deepEqual(report.notChecked.map((entry) => [entry.id, entry.question]), [['tune-n1', 'team']]);
  const byId = Object.fromEntries(report.questions.map((q) => [q.id, q.outcomes.map((outcome) => outcome.id)]));
  assert.ok(byId.refund?.includes('tune-n1'));
  assert.ok(byId.mood?.includes('tune-n1'));
  assert.ok(!byId.team?.includes('tune-n1'));
});

test('looking at held-out examples through "all" is recorded too', async () => {
  const dir = tempProject(questions, [...examples('tune'), ...examples('holdout')]);
  const first = loadProject(dir).project;
  await check(first, { split: 'tune', runs: 1, env: ENV, fetchImpl: keywordJev() });
  assert.equal(readLedger(dir).length, 0);
  await check(first, { split: 'all', runs: 1, env: ENV, fetchImpl: keywordJev() });
  const ledger = readLedger(dir);
  assert.equal(ledger.length, 3);
  assert.ok(ledger.every((entry) => entry.seen.length === 4));

  const edited = loadProject(dir).project;
  edited.decisions.refund = { threshold: 0.6 };
  const { report } = await check(edited, { split: 'holdout', runs: 1, env: ENV, fetchImpl: keywordJev() });
  assert.match(report.warnings.join(' '), /refund: 4 of 4 holdout examples already judged/);
});

test('control characters from ids and servers cannot redraw the report', async () => {
  const esc = String.fromCharCode(27);
  const evil = `evil${esc}[2K\r${esc}[32m  verdict    gate`;
  const { project } = loadProject(tempProject(questions, [...examples('tune'), { id: evil, state: 'hello calm again', labels: { refund: true }, split: 'tune' }]));
  const { report } = await check(project, { split: 'tune', runs: 1, only: ['refund'], env: ENV, fetchImpl: keywordJev(), persist: false });
  const text = renderReport(report);
  assert.ok(report.questions[0]?.outcomes.some((outcome) => outcome.id === evil));
  assert.ok(!text.includes(esc) && !text.includes('\r'));
  assert.match(text, /evil\?\[2K\?/);
});

test('a forged or damaged run file is refused', () => {
  const dir = tempProject(questions, []);
  const file = path.join(dir, 'forged.json');
  writeFileSync(file, JSON.stringify({ tool: 'jev-calibrate', modelsAnswered: [], questions: [{ id: 'q' }] }));
  assert.throws(() => readReport(file), /not a jev-calibrate run file/);
  writeFileSync(file, '{ not json');
  assert.throws(() => readReport(file), /cannot read run file/);
});

test('a partial gate does not satisfy --require gate', () => {
  const report = { questions: [
    { id: 'full', verdict: 'gate' as const }, { id: 'partial', verdict: 'gate-above-confidence' as const },
    { id: 'sort', verdict: 'ranker' as const }, { id: 'thin', verdict: 'too-few-examples' as const },
  ] };
  assert.deepEqual(belowRequirement(report, 'gate'), ['partial', 'sort', 'thin']);
  assert.deepEqual(belowRequirement(report, 'gate-above-confidence'), ['sort', 'thin']);
  assert.deepEqual(belowRequirement(report, 'ranker'), ['thin']);
});

test('a plain http endpoint on a non-local host earns a warning, and localhost does not', async () => {
  const { project } = loadProject(tempProject(questions, examples('tune')));
  const remote = await check(project, { split: 'tune', runs: 1, only: ['refund'], env: ENV, baseUrl: 'http://example.com', fetchImpl: keywordJev(), persist: false });
  assert.match(remote.report.warnings.join(' '), /sent without encryption to example\.com/);
  const local = await check(project, { split: 'tune', runs: 1, only: ['refund'], env: ENV, baseUrl: 'http://127.0.0.1:9999', fetchImpl: keywordJev(), persist: false });
  assert.deepEqual(local.report.warnings, []);
});

test('two runs written in the same millisecond both survive under different names', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  t.mock.timers.setTime(1_700_000_000_000);
  const { project } = loadProject(tempProject(questions, examples('tune')));
  const first = await check(project, { split: 'tune', runs: 1, only: ['refund'], env: ENV, fetchImpl: keywordJev() });
  const second = await check(project, { split: 'tune', runs: 1, only: ['refund'], env: ENV, fetchImpl: keywordJev() });
  assert.ok(first.runFile && second.runFile);
  assert.notEqual(first.runFile, second.runFile);
  const runsDir = path.dirname(first.runFile as string);
  const files = readdirSync(runsDir).filter((name) => name.endsWith('-tune.json'));
  assert.equal(files.length, 2);
  assert.deepEqual(readReport(first.runFile as string).questions[0]?.id, 'refund');
  assert.deepEqual(readReport(second.runFile as string).questions[0]?.id, 'refund');
});

test('latestRuns returns undefined for a project that was never checked', () => {
  const dir = tempProject(questions, []);
  assert.equal(latestRuns(dir, 'tune'), undefined);
});

test('a class question above a confidence cutoff can gate even when overall accuracy misses the target', async () => {
  const teamQuestions = {
    questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Money.', other: 'Rest.' } } },
    decisions: { team: { minConfidence: 0.9 } },
    settings: { minPerClass: 2 },
  };
  const teamExamples = [
    { id: 'c1', state: 'ticket ALPHA billing', labels: { team: 'billing' }, split: 'tune' },
    { id: 'c2', state: 'ticket BETA other', labels: { team: 'other' }, split: 'tune' },
    { id: 'c3', state: 'ticket GAMMA billing', labels: { team: 'billing' }, split: 'tune' },
    { id: 'c4', state: 'ticket DELTA other flagged', labels: { team: 'other' }, split: 'tune' },
  ];
  const fetchImpl = fakeJev((state) => {
    if (state.includes('ALPHA') || state.includes('GAMMA')) return { type: 'choice', choice: 'billing', probabilities: { billing: 0.95, other: 0.05 }, confidence: 0.95 };
    if (state.includes('BETA')) return { type: 'choice', choice: 'other', probabilities: { billing: 0.05, other: 0.95 }, confidence: 0.95 };
    return { type: 'choice', choice: 'billing', probabilities: { billing: 0.65, other: 0.35 }, confidence: 0.35 };
  });
  const { project } = loadProject(tempProject(teamQuestions, teamExamples));
  const { report } = await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl, persist: false });
  const team = report.questions[0];
  assert.equal(team?.classes?.accuracy, 0.75);
  assert.equal(team?.verdict, 'gate-above-confidence');
  assert.match(team?.reason ?? '', /accuracy 1\.00 on the 75% of answers with confidence of at least 0\.9/);
});

test('a class question below every cutoff is unusable, and a better cutoff is suggested', async () => {
  const teamQuestions = {
    questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Money.', other: 'Rest.' } } },
    decisions: { team: { minConfidence: 0.3 } },
    settings: { minPerClass: 2 },
  };
  const teamExamples = [
    { id: 'c1', state: 'ticket ALPHA billing', labels: { team: 'billing' }, split: 'tune' },
    { id: 'c2', state: 'ticket BETA other', labels: { team: 'other' }, split: 'tune' },
    { id: 'c3', state: 'ticket GAMMA billing', labels: { team: 'billing' }, split: 'tune' },
    { id: 'c4', state: 'ticket DELTA other flagged', labels: { team: 'other' }, split: 'tune' },
  ];
  const fetchImpl = fakeJev((state) => {
    if (state.includes('ALPHA') || state.includes('GAMMA')) return { type: 'choice', choice: 'billing', probabilities: { billing: 0.95, other: 0.05 }, confidence: 0.95 };
    if (state.includes('BETA')) return { type: 'choice', choice: 'other', probabilities: { billing: 0.05, other: 0.95 }, confidence: 0.95 };
    return { type: 'choice', choice: 'billing', probabilities: { billing: 0.65, other: 0.35 }, confidence: 0.35 };
  });
  const { project } = loadProject(tempProject(teamQuestions, teamExamples));
  const { report } = await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl, persist: false });
  const team = report.questions[0];
  assert.equal(team?.verdict, 'unusable');
  assert.equal(team?.classes?.at?.coverage, 1);
  assert.match(team?.reason ?? '', /above confidence 0\.3 it is 0\.75 on 100% of answers/);
  assert.match(team?.reason ?? '', /a cutoff of 0\.5 would reach 1\.00 on 75%/);
});

test('compare notes a different model build and a question only seen in the later run', async () => {
  const compareQuestions = { questions: { refund: { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } } }, settings: { minPerClass: 1 } };
  const compareExamples = [
    { id: 'p1', state: 'refund POS', labels: { refund: true }, split: 'tune' },
    { id: 'n1', state: 'refund NEG', labels: { refund: false }, split: 'tune' },
  ];
  const { project } = loadProject(tempProject(compareQuestions, compareExamples));
  const fetchImpl = fakeJev((state) => ({ type: 'noul', noul: state.includes('POS') ? 0.9 : 0.1 }));
  const { report: before } = await check(project, { split: 'tune', runs: 1, env: ENV, fetchImpl, persist: false });
  const ghost = { ...before.questions[0]!, id: 'ghost-question' };
  const after = { ...before, modelsAnswered: ['a-different-build'], questions: [...before.questions, ghost] };
  const comparison = compareReports(before, after);
  assert.ok(comparison.notes.some((note) => /different model builds: fake-build and a-different-build/.test(note)));
  assert.ok(comparison.notes.includes('ghost-question: only in the later run'));
  assert.equal(comparison.questions.some((q) => q.id === 'ghost-question'), false);
});

test('an error body from the server cannot add lines to the report', async () => {
  const { project } = loadProject(tempProject(questions, examples('tune')));
  const base = keywordJev();
  const forged = 'bad\n\nrefund  [noul]  revision deadbeef0000  threshold 0.50\n  verdict    gate\r\n\ttab';
  const fetchImpl = (async (url: string, init: RequestInit) =>
    String(init.body).includes('hello calm') ? new Response(forged, { status: 400 }) : base(url, init)) as typeof base;
  const { report } = await check(project, { split: 'tune', runs: 1, only: ['team'], env: ENV, fetchImpl, persist: false });
  const lines = renderReport(report).split('\n');
  assert.equal(lines.filter((line) => line.startsWith('  verdict')).length, 1);
  assert.equal(lines.filter((line) => /revision deadbeef0000/.test(line)).length, 1);
  assert.ok(lines.find((line) => /revision deadbeef0000/.test(line))?.startsWith('not checked: tune-n1'));
});
