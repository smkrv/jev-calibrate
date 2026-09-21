import { plain } from './plain.ts';
import type { QuestionReport, Report } from './report.ts';

export type QuestionDelta = {
  id: string;
  before: { revision: string; verdict: string };
  after: { revision: string; verdict: string };
  metrics: { name: string; before?: number; after?: number }[];
  /** Wrong before, right now. */
  fixed: string[];
  /** Right before, wrong now: the reason to replay every case after each edit. */
  regressed: string[];
};

export type Comparison = { notes: string[]; questions: QuestionDelta[] };

function keyMetrics(q: QuestionReport): Record<string, number | undefined> {
  if (q.noul) return { AUC: q.noul.auc, precision: q.noul.at.precision, recall: q.noul.at.recall };
  return { accuracy: q.classes?.accuracy, 'accuracy above cutoff': q.classes?.at?.accuracy };
}

export function compareReports(before: Report, after: Report): Comparison {
  const notes: string[] = [];
  if (before.split !== after.split) notes.push(`different splits: ${before.split} and ${after.split}`);
  if (before.modelsAnswered.join() !== after.modelsAnswered.join()) {
    notes.push(`different model builds: ${before.modelsAnswered.join(', ')} and ${after.modelsAnswered.join(', ')}`);
  }
  const questions: QuestionDelta[] = [];
  for (const now of after.questions) {
    const was = before.questions.find((question) => question.id === now.id);
    if (!was) {
      notes.push(`${now.id}: only in the later run`);
      continue;
    }
    const earlier = new Map(was.outcomes.map((outcome) => [outcome.id, outcome.correct]));
    const fixed: string[] = [];
    const regressed: string[] = [];
    for (const outcome of now.outcomes) {
      const previous = earlier.get(outcome.id);
      if (previous === undefined) continue;
      if (!previous && outcome.correct) fixed.push(outcome.id);
      if (previous && !outcome.correct) regressed.push(outcome.id);
    }
    const a = keyMetrics(was);
    const b = keyMetrics(now);
    const metrics = Object.keys(b).flatMap((name) => {
      if (a[name] === undefined && b[name] === undefined) return [];
      const row: { name: string; before?: number; after?: number } = { name };
      if (a[name] !== undefined) row.before = a[name] as number;
      if (b[name] !== undefined) row.after = b[name] as number;
      return [row];
    });
    questions.push({
      id: now.id,
      before: { revision: was.revision, verdict: was.verdict },
      after: { revision: now.revision, verdict: now.verdict },
      metrics, fixed, regressed,
    });
  }
  return { notes, questions };
}

export function renderComparison(comparison: Comparison): string {
  const lines: string[] = comparison.notes.map((note) => `note: ${note}`);
  const show = (value: number | undefined): string => (value === undefined ? 'n/a' : value.toFixed(2));
  for (const q of comparison.questions) {
    lines.push('', `${q.id}  ${q.before.revision} -> ${q.after.revision}${q.before.revision === q.after.revision ? '  (same revision)' : ''}`);
    lines.push(`  verdict    ${q.before.verdict} -> ${q.after.verdict}`);
    for (const metric of q.metrics) lines.push(`  ${metric.name.padEnd(10)} ${show(metric.before)} -> ${show(metric.after)}`);
    lines.push(`  fixed      ${q.fixed.length === 0 ? 'none' : q.fixed.join(', ')}`);
    lines.push(`  regressed  ${q.regressed.length === 0 ? 'none' : q.regressed.join(', ')}`);
  }
  return lines.map(plain).join('\n').trimStart();
}
