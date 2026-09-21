import type { Targets } from './types.ts';

export type NoulPoint = { id: string; group?: string; label: boolean; value: number };
export type ClassPoint = { id: string; label: string; predicted: string; confidence: number };

export function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Probability that a positive example scores above a negative one, ties counting half.
 * Needs no threshold, so it does not depend on how well the probabilities are calibrated.
 */
export function auc(points: NoulPoint[]): number | undefined {
  const positives = points.filter((point) => point.label);
  const negatives = points.filter((point) => !point.label);
  if (positives.length === 0 || negatives.length === 0) return undefined;
  let wins = 0;
  for (const positive of positives) {
    for (const negative of negatives) {
      if (positive.value > negative.value) wins += 1;
      else if (positive.value === negative.value) wins += 0.5;
    }
  }
  return wins / (positives.length * negatives.length);
}

export type Confusion = {
  threshold: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  precision?: number;
  recall?: number;
  falsePositiveRate?: number;
  accuracy: number;
};

/** "Yes" means a value at or above the threshold. */
export function confusionAt(points: NoulPoint[], threshold: number): Confusion {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const point of points) {
    const yes = point.value >= threshold;
    if (point.label) yes ? (tp += 1) : (fn += 1);
    else yes ? (fp += 1) : (tn += 1);
  }
  const result: Confusion = { threshold, tp, fp, tn, fn, accuracy: points.length === 0 ? 0 : (tp + tn) / points.length };
  if (tp + fp > 0) result.precision = tp / (tp + fp);
  if (tp + fn > 0) result.recall = tp / (tp + fn);
  if (fp + tn > 0) result.falsePositiveRate = fp / (fp + tn);
  return result;
}

/**
 * Candidates are the midpoints between neighbouring observed values. The pick is the one
 * with the highest recall among those that reach the precision target; when none does,
 * the one with the best balance of hits and false alarms (Youden's J). Ties go to the
 * value nearest 0.5. Only meaningful on the tune split.
 */
export function suggestThreshold(points: NoulPoint[], targets: Targets): Confusion | undefined {
  const values = [...new Set(points.map((point) => point.value))].sort((a, b) => a - b);
  if (values.length < 2 || auc(points) === undefined) return undefined;
  const candidates: Confusion[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const midpoint = ((values[index - 1] as number) + (values[index] as number)) / 2;
    // Six places: short enough to copy into "decisions", fine enough to keep close neighbours apart.
    candidates.push(confusionAt(points, Number(midpoint.toFixed(6))));
  }
  const nearerHalf = (a: Confusion, b: Confusion): number => Math.abs(a.threshold - 0.5) - Math.abs(b.threshold - 0.5);
  const precise = candidates.filter((c) => (c.precision ?? 0) >= targets.precision && (c.recall ?? 0) > 0);
  if (precise.length > 0) {
    return precise.sort((a, b) => (b.recall ?? 0) - (a.recall ?? 0) || nearerHalf(a, b))[0];
  }
  const youden = (c: Confusion): number => (c.recall ?? 0) - (c.falsePositiveRate ?? 0);
  return candidates.sort((a, b) => youden(b) - youden(a) || nearerHalf(a, b))[0];
}

/**
 * Inside a group the examples share their context, so the comparison isolates the labelled
 * property: every positive member should score above every negative member.
 */
export function groupedPairs(points: NoulPoint[]): { correct: number; total: number } {
  const groups = new Map<string, NoulPoint[]>();
  for (const point of points) {
    if (!point.group) continue;
    groups.set(point.group, [...(groups.get(point.group) ?? []), point]);
  }
  let correct = 0;
  let total = 0;
  for (const members of groups.values()) {
    for (const positive of members.filter((member) => member.label)) {
      for (const negative of members.filter((member) => !member.label)) {
        total += 1;
        if (positive.value > negative.value) correct += 1;
      }
    }
  }
  return { correct, total };
}

export function brier(points: NoulPoint[]): number | undefined {
  return mean(points.map((point) => (point.value - (point.label ? 1 : 0)) ** 2));
}

export type ReliabilityBin = { from: number; to: number; count: number; meanPredicted?: number; observed?: number };

/** Does "0.8" come true about 80% of the time? Read it only with enough examples per bin. */
export function reliability(points: NoulPoint[], bins = 5): ReliabilityBin[] {
  const result: ReliabilityBin[] = [];
  for (let index = 0; index < bins; index += 1) {
    const from = index / bins;
    const to = (index + 1) / bins;
    const inside = points.filter((point) => point.value >= from && (index === bins - 1 ? point.value <= to : point.value < to));
    const bin: ReliabilityBin = { from, to, count: inside.length };
    const predicted = mean(inside.map((point) => point.value));
    const observed = mean(inside.map((point) => (point.label ? 1 : 0)));
    if (predicted !== undefined) bin.meanPredicted = predicted;
    if (observed !== undefined) bin.observed = observed;
    result.push(bin);
  }
  return result;
}

export function accuracy(points: ClassPoint[]): number | undefined {
  return mean(points.map((point) => (point.predicted === point.label ? 1 : 0)));
}

export function confusionTable(points: ClassPoint[]): Record<string, Record<string, number>> {
  // Keys come from project files and API answers: no prototype to reach through them.
  const table: Record<string, Record<string, number>> = Object.create(null);
  for (const point of points) {
    const row = (table[point.label] ??= Object.create(null) as Record<string, number>);
    row[point.predicted] = (row[point.predicted] ?? 0) + 1;
  }
  return table;
}

export type SelectiveRow = { minConfidence: number; covered: number; coverage: number; accuracy?: number };

/** Accuracy among the answers that would be acted on automatically at a confidence cutoff. */
export function selectiveAt(points: ClassPoint[], minConfidence: number): SelectiveRow {
  const covered = points.filter((point) => point.confidence >= minConfidence);
  const row: SelectiveRow = {
    minConfidence,
    covered: covered.length,
    coverage: points.length === 0 ? 0 : covered.length / points.length,
  };
  const value = accuracy(covered);
  if (value !== undefined) row.accuracy = value;
  return row;
}

/** Lowest cutoff that reaches the accuracy target while keeping enough answers automatic. Tune split only. */
export function suggestMinConfidence(points: ClassPoint[], targets: Targets): SelectiveRow | undefined {
  for (let step = 10; step <= 19; step += 1) {
    const row = selectiveAt(points, step / 20);
    if ((row.accuracy ?? 0) >= targets.accuracy && row.coverage >= targets.coverage) return row;
  }
  return undefined;
}

/** Wrong answers given with high confidence: the cases a confidence cutoff cannot catch. */
export function confidentErrors(points: ClassPoint[], minConfidence = 0.9): ClassPoint[] {
  return points.filter((point) => point.predicted !== point.label && point.confidence >= minConfidence);
}

export function argmax(distribution: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestValue = -1;
  for (const [key, value] of Object.entries(distribution)) {
    if (value > bestValue) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

export function averageDistributions(distributions: Record<string, number>[]): Record<string, number> {
  const total: Record<string, number> = Object.create(null);
  for (const distribution of distributions) {
    for (const [key, value] of Object.entries(distribution)) total[key] = (total[key] ?? 0) + value / distributions.length;
  }
  return total;
}
