import { revisionOf } from './hash.ts';
import { plain } from './plain.ts';
import {
  accuracy, argmax, auc, averageDistributions, brier, confidentErrors, confusionAt, confusionTable, groupedPairs,
  mean, reliability, selectiveAt, suggestMinConfidence, suggestThreshold,
} from './metrics.ts';
import type { ClassPoint, Confusion, NoulPoint, ReliabilityBin, SelectiveRow } from './metrics.ts';
import type { RawExample, RawRun } from './run.ts';
import type { ChoiceAnswer, Decision, Example, Label, Project, Question, ScoreAnswer, Split } from './types.ts';

export type Verdict = 'gate' | 'gate-above-confidence' | 'ranker' | 'unusable' | 'too-few-examples';

/** "gate-above-confidence" sends part of the answers to review, so it must not pass for a full gate in CI. */
const RANK: Record<Verdict, number> = { gate: 4, 'gate-above-confidence': 3, ranker: 2, unusable: 1, 'too-few-examples': 0 };
export const REQUIRABLE = ['gate', 'gate-above-confidence', 'ranker'] as const;
export type Requirable = (typeof REQUIRABLE)[number];

/** Questions whose verdict is below the required one. */
export function belowRequirement(report: { questions: { id: string; verdict: Verdict }[] }, required: Requirable): string[] {
  return report.questions.filter((question) => RANK[question.verdict] < RANK[required]).map((question) => question.id);
}

export type Outcome = {
  id: string;
  label: Label;
  /** noul: mean probability. choice: chosen option. score: chosen level. */
  value: number | string;
  confidence?: number;
  /** Judged at the operating point in "decisions". */
  correct: boolean;
  /** Spread across runs: probability for noul, confidence otherwise. */
  range?: number;
  /** The verdict itself changed between runs. */
  flipped?: boolean;
};

export type NoulDetail = {
  meanPositive?: number;
  meanNegative?: number;
  auc?: number;
  at: Confusion;
  suggested?: Confusion;
  pairs?: { correct: number; total: number };
  brier?: number;
  reliability: ReliabilityBin[];
};

export type ClassDetail = {
  accuracy?: number;
  withinOne?: number;
  meanAbsoluteError?: number;
  confidenceWhenRight?: number;
  confidenceWhenWrong?: number;
  at?: SelectiveRow;
  suggested?: SelectiveRow;
  selective: SelectiveRow[];
  confusion: Record<string, Record<string, number>>;
  confidentErrors: string[];
};

export type QuestionReport = {
  id: string;
  type: Question['type'];
  revision: string;
  decision: Decision;
  verdict: Verdict;
  reason: string;
  counts: Record<string, number>;
  noul?: NoulDetail;
  classes?: ClassDetail;
  stability?: { runs: number; maxRange: number; flips: number };
  outcomes: Outcome[];
};

export type Report = {
  tool: 'jev-calibrate';
  version: string;
  createdAt: string;
  split: Split | 'all';
  runs: number;
  provider: string;
  modelRequested: string;
  modelsAnswered: string[];
  checked: number;
  /** Whole examples whose request failed, and single questions whose answer was unusable. */
  notChecked: { id: string; question?: string; error: string }[];
  requests: number;
  costUsd?: number;
  seconds: number;
  warnings: string[];
  questions: QuestionReport[];
};

const pct = (value: number | undefined): string => (value === undefined ? 'n/a' : value.toFixed(2));

function range(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values);
}

function levelOf(answer: ChoiceAnswer | ScoreAnswer): string | undefined {
  return answer.type === 'choice' ? answer.choice : argmax(answer.probabilities);
}

function reportNoul(
  id: string, question: Question, decision: Decision, rows: { example: Example; raw: RawExample }[], project: Project, split: Split | 'all',
): QuestionReport {
  const threshold = decision.threshold ?? 0.5;
  const { targets, minPerClass } = project.settings;
  const points: NoulPoint[] = [];
  const outcomes: Outcome[] = [];
  let flips = 0;
  let maxRange = 0;
  for (const { example, raw } of rows) {
    const values = (raw.answers[id] ?? []).flatMap((answer) => (answer.type === 'noul' ? [answer.noul] : []));
    const value = mean(values);
    if (value === undefined) continue;
    const label = example.labels[id] as boolean;
    const point: NoulPoint = { id: example.id, label, value };
    if (example.group) point.group = example.group;
    points.push(point);
    const spread = range(values);
    const flipped = new Set(values.map((v) => v >= threshold)).size > 1;
    if (flipped) flips += 1;
    maxRange = Math.max(maxRange, spread);
    const outcome: Outcome = { id: example.id, label, value, correct: value >= threshold === label };
    if (values.length > 1) {
      outcome.range = spread;
      outcome.flipped = flipped;
    }
    outcomes.push(outcome);
  }

  const positives = points.filter((point) => point.label);
  const negatives = points.filter((point) => !point.label);
  const at = confusionAt(points, threshold);
  const detail: NoulDetail = { at, reliability: reliability(points) };
  const meanPositive = mean(positives.map((point) => point.value));
  const meanNegative = mean(negatives.map((point) => point.value));
  const area = auc(points);
  const score = brier(points);
  if (meanPositive !== undefined) detail.meanPositive = meanPositive;
  if (meanNegative !== undefined) detail.meanNegative = meanNegative;
  if (area !== undefined) detail.auc = area;
  if (score !== undefined) detail.brier = score;
  const pairs = groupedPairs(points);
  if (pairs.total > 0) detail.pairs = pairs;
  // A threshold picked on the holdout would turn the holdout into a tuning set.
  if (split !== 'holdout') {
    const suggested = suggestThreshold(points, targets);
    if (suggested && suggested.threshold !== threshold) detail.suggested = suggested;
  }

  let verdict: Verdict;
  let reason: string;
  if (positives.length < minPerClass || negatives.length < minPerClass) {
    verdict = 'too-few-examples';
    reason = `${positives.length} positive and ${negatives.length} negative examples; ${minPerClass} of each are needed before the numbers mean much`;
  } else if ((at.precision ?? 0) >= targets.precision && (at.recall ?? 0) >= targets.recall) {
    verdict = 'gate';
    reason = `at ${threshold.toFixed(2)} precision ${pct(at.precision)} and recall ${pct(at.recall)} reach the targets ${targets.precision} and ${targets.recall}`;
  } else if ((area ?? 0) >= targets.auc) {
    verdict = 'ranker';
    const better = detail.suggested;
    const reachable = better !== undefined && (better.precision ?? 0) >= targets.precision && (better.recall ?? 0) >= targets.recall;
    const advice = reachable
      ? `the order is right and the cut is off: set decisions.${id}.threshold to ${better.threshold.toFixed(2)} and check again`
      : split === 'holdout'
        ? 'the configured threshold does not hold up on the held-out examples; until it does, sort by the probability instead of cutting on it'
        : 'no threshold on these examples reaches both targets: sort by the probability, do not cut on it';
    reason = `orders examples well (AUC ${pct(area)}) but at ${threshold.toFixed(2)} precision ${pct(at.precision)} and recall ${pct(at.recall)} miss the targets; ${advice}`;
  } else {
    verdict = 'unusable';
    reason = `AUC ${pct(area)} is below ${targets.auc}, and at ${threshold.toFixed(2)} precision ${pct(at.precision)} and recall ${pct(at.recall)} miss the targets`;
  }

  const result: QuestionReport = {
    id, type: 'noul', revision: revisionOf(question, decision), decision, verdict, reason,
    counts: { true: positives.length, false: negatives.length }, noul: detail, outcomes,
  };
  const runs = Math.max(0, ...rows.map(({ raw }) => raw.answers[id]?.length ?? 0));
  if (runs > 1) result.stability = { runs, maxRange, flips };
  return result;
}

function reportClasses(
  id: string, question: Question, decision: Decision, rows: { example: Example; raw: RawExample }[], project: Project, split: Split | 'all',
): QuestionReport {
  const { targets, minPerClass } = project.settings;
  const points: ClassPoint[] = [];
  const outcomes: Outcome[] = [];
  const errors: number[] = [];
  let flips = 0;
  let maxRange = 0;
  for (const { example, raw } of rows) {
    const answers = (raw.answers[id] ?? []).filter((answer) => answer.type !== 'noul');
    if (answers.length === 0) continue;
    const predicted = argmax(averageDistributions(answers.map((answer) => answer.probabilities)));
    if (predicted === undefined) continue;
    const confidence = mean(answers.map((answer) => answer.confidence)) ?? 0;
    const label = String(example.labels[id]);
    points.push({ id: example.id, label, predicted, confidence });
    if (question.type === 'score') {
      const score = mean(answers.flatMap((answer) => (answer.type === 'score' ? [answer.score] : []))) ?? 0;
      errors.push(Math.abs(score - Number(label)));
    }
    const spread = range(answers.map((answer) => answer.confidence));
    const flipped = new Set(answers.map(levelOf)).size > 1;
    if (flipped) flips += 1;
    maxRange = Math.max(maxRange, spread);
    const outcome: Outcome = { id: example.id, label: example.labels[id] as Label, value: predicted, confidence, correct: predicted === label };
    if (answers.length > 1) {
      outcome.range = spread;
      outcome.flipped = flipped;
    }
    outcomes.push(outcome);
  }

  const overall = accuracy(points);
  const detail: ClassDetail = {
    selective: [0.5, 0.7, 0.9].map((cutoff) => selectiveAt(points, cutoff)),
    confusion: confusionTable(points),
    confidentErrors: confidentErrors(points).map((point) => point.id),
  };
  if (overall !== undefined) detail.accuracy = overall;
  const right = mean(points.filter((p) => p.predicted === p.label).map((p) => p.confidence));
  const wrong = mean(points.filter((p) => p.predicted !== p.label).map((p) => p.confidence));
  if (right !== undefined) detail.confidenceWhenRight = right;
  if (wrong !== undefined) detail.confidenceWhenWrong = wrong;
  if (question.type === 'score') {
    const near = mean(points.map((p) => (Math.abs(Number(p.predicted) - Number(p.label)) <= 1 ? 1 : 0)));
    const mae = mean(errors);
    if (near !== undefined) detail.withinOne = near;
    if (mae !== undefined) detail.meanAbsoluteError = mae;
  }
  if (decision.minConfidence !== undefined) detail.at = selectiveAt(points, decision.minConfidence);
  if (split !== 'holdout' && (overall ?? 0) < targets.accuracy) {
    const suggested = suggestMinConfidence(points, targets);
    if (suggested && suggested.minConfidence !== decision.minConfidence) detail.suggested = suggested;
  }

  let verdict: Verdict;
  let reason: string;
  const labelledClasses = new Set(points.map((point) => point.label));
  if (labelledClasses.size < 2) {
    // A model that always gives the one labelled answer would score 1.00 here.
    verdict = 'too-few-examples';
    reason = `every labelled example is "${[...labelledClasses][0] ?? ''}"; accuracy on a single class says nothing about the question`;
  } else if (points.length < minPerClass * 2) {
    verdict = 'too-few-examples';
    reason = `${points.length} labelled examples; at least ${minPerClass * 2} are needed before the numbers mean much`;
  } else if ((overall ?? 0) >= targets.accuracy) {
    verdict = 'gate';
    reason = `accuracy ${pct(overall)} reaches the target ${targets.accuracy} on every answer`;
  } else if (detail.at && (detail.at.accuracy ?? 0) >= targets.accuracy && detail.at.coverage >= targets.coverage) {
    verdict = 'gate-above-confidence';
    reason = `accuracy ${pct(detail.at.accuracy)} on the ${Math.round(detail.at.coverage * 100)}% of answers with confidence of at least ${detail.at.minConfidence}; the rest go to review`;
  } else {
    verdict = 'unusable';
    reason = `accuracy ${pct(overall)} is below ${targets.accuracy}`;
    if (detail.at) reason += `, and above confidence ${detail.at.minConfidence} it is ${pct(detail.at.accuracy)} on ${Math.round(detail.at.coverage * 100)}% of answers`;
    if (detail.suggested) reason += `; a cutoff of ${detail.suggested.minConfidence} would reach ${pct(detail.suggested.accuracy)} on ${Math.round(detail.suggested.coverage * 100)}%`;
  }

  const counts: Record<string, number> = Object.create(null);
  for (const point of points) counts[point.label] = (counts[point.label] ?? 0) + 1;
  const result: QuestionReport = {
    id, type: question.type, revision: revisionOf(question, decision), decision, verdict, reason, counts, classes: detail, outcomes,
  };
  const runs = Math.max(0, ...rows.map(({ raw }) => raw.answers[id]?.length ?? 0));
  if (runs > 1) result.stability = { runs, maxRange, flips };
  return result;
}

export function buildReport(
  project: Project,
  examples: Example[],
  run: RawRun,
  meta: { version: string; split: Split | 'all'; runs: number; provider: string; model: string; warnings: string[]; only?: string[] },
): Report {
  const byId = new Map(examples.map((example) => [example.id, example]));
  const checked = run.examples.filter((raw) => !raw.error);
  const questions: QuestionReport[] = [];
  for (const [id, question] of Object.entries(project.questions)) {
    if (meta.only && !meta.only.includes(id)) continue;
    const rows = checked
      .filter((raw) => (raw.answers[id]?.length ?? 0) > 0)
      .map((raw) => ({ example: byId.get(raw.id) as Example, raw }));
    if (rows.length === 0) continue;
    const decision = project.decisions[id] ?? {};
    questions.push(
      question.type === 'noul'
        ? reportNoul(id, question, decision, rows, project, meta.split)
        : reportClasses(id, question, decision, rows, project, meta.split),
    );
  }
  const report: Report = {
    tool: 'jev-calibrate',
    version: meta.version,
    createdAt: new Date().toISOString(),
    split: meta.split,
    runs: meta.runs,
    provider: meta.provider,
    modelRequested: meta.model,
    modelsAnswered: run.models,
    checked: checked.length,
    notChecked: run.examples.flatMap((raw) => {
      if (raw.error) return [{ id: raw.id, error: raw.error }];
      return Object.entries(raw.failed ?? {})
        .filter(([question]) => !meta.only || meta.only.includes(question))
        .map(([question, error]) => ({ id: raw.id, question, error }));
    }),
    requests: run.requests,
    seconds: run.seconds,
    warnings: meta.warnings,
    questions,
  };
  if (run.costUsd !== undefined) report.costUsd = run.costUsd;
  return report;
}

function renderQuestion(q: QuestionReport): string[] {
  const lines: string[] = [];
  const point = q.type === 'noul' ? `threshold ${(q.decision.threshold ?? 0.5).toFixed(2)}` : q.decision.minConfidence === undefined ? 'no confidence cutoff' : `min confidence ${q.decision.minConfidence}`;
  lines.push(`${q.id}  [${q.type}]  revision ${q.revision}  ${point}`);
  lines.push(`  verdict    ${q.verdict}`);
  lines.push(`             ${q.reason}`);
  lines.push(`  examples   ${Object.entries(q.counts).map(([name, count]) => `${name}: ${count}`).join(', ')}`);
  if (q.noul) {
    const n = q.noul;
    lines.push(`  means      ${pct(n.meanPositive)} when true, ${pct(n.meanNegative)} when false`);
    lines.push(`  AUC        ${pct(n.auc)}`);
    lines.push(`  at ${n.at.threshold.toFixed(2)}    precision ${pct(n.at.precision)}, recall ${pct(n.at.recall)}, false positives ${n.at.fp}/${n.at.fp + n.at.tn}`);
    if (n.suggested) lines.push(`  suggested  threshold ${n.suggested.threshold.toFixed(2)}: precision ${pct(n.suggested.precision)}, recall ${pct(n.suggested.recall)}`);
    if (n.pairs) lines.push(`  in groups  ${n.pairs.correct}/${n.pairs.total} true-over-false pairs ordered correctly`);
    lines.push(`  Brier      ${pct(n.brier)}`);
  }
  if (q.classes) {
    const c = q.classes;
    lines.push(`  accuracy   ${pct(c.accuracy)}${c.withinOne === undefined ? '' : `, within one level ${pct(c.withinOne)}, mean error ${pct(c.meanAbsoluteError)} levels`}`);
    lines.push(`  confidence ${pct(c.confidenceWhenRight)} when right, ${pct(c.confidenceWhenWrong)} when wrong`);
    for (const row of c.selective) {
      lines.push(`  at >= ${row.minConfidence.toFixed(1)}  accuracy ${pct(row.accuracy)} on ${row.covered} answers (${Math.round(row.coverage * 100)}%)`);
    }
    if (c.suggested) lines.push(`  suggested  min confidence ${c.suggested.minConfidence}: accuracy ${pct(c.suggested.accuracy)} on ${Math.round(c.suggested.coverage * 100)}%`);
    if (c.confidentErrors.length > 0) lines.push(`  wrong at confidence >= 0.9: ${c.confidentErrors.join(', ')}`);
  }
  if (q.stability) {
    lines.push(`  stability  ${q.stability.runs} runs, largest spread ${q.stability.maxRange.toFixed(2)}, ${q.stability.flips} changed verdict${q.stability.flips === 1 ? '' : 's'}`);
  }
  const misses = q.outcomes.filter((outcome) => !outcome.correct);
  if (misses.length > 0) {
    lines.push(`  misses     ${misses.length}`);
    for (const miss of misses.slice(0, 12)) {
      const value = typeof miss.value === 'number' ? miss.value.toFixed(2) : miss.value;
      const confidence = miss.confidence === undefined ? '' : `, confidence ${miss.confidence.toFixed(2)}`;
      lines.push(`             ${miss.id}: expected ${String(miss.label)}, got ${value}${confidence}`);
    }
    if (misses.length > 12) lines.push(`             and ${misses.length - 12} more in the run file`);
  }
  return lines;
}

export function renderReport(report: Report): string {
  const lines: string[] = [];
  const cost = report.costUsd === undefined ? '' : `, $${report.costUsd.toFixed(5)}`;
  lines.push(`split ${report.split}, ${report.runs} run${report.runs === 1 ? '' : 's'}, ${report.provider}, ${report.modelsAnswered.join(', ') || report.modelRequested}`);
  lines.push(`${report.checked} examples checked, ${report.notChecked.length} not checked, ${report.requests} requests, ${report.seconds.toFixed(1)} s${cost}`);
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  for (const failed of report.notChecked.slice(0, 5)) {
    lines.push(`not checked: ${failed.id}${failed.question ? `, question ${failed.question}` : ''}: ${failed.error}`);
  }
  if (report.notChecked.length > 5) lines.push(`not checked: and ${report.notChecked.length - 5} more in the run file`);
  for (const question of report.questions) lines.push('', ...renderQuestion(question));
  return lines.map(plain).join('\n');
}
