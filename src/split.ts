import { sha256 } from './hash.ts';
import type { Example, Split } from './types.ts';

/**
 * Deterministic assignment: the same example lands in the same split on every machine
 * and keeps its place when other examples are added. Grouped examples share a key, so a
 * matched pair is never divided between tune and holdout.
 */
export function splitOf(example: Example, holdoutFraction: number): Split {
  if (example.split) return example.split;
  const key = example.group ?? example.id;
  const bucket = Number.parseInt(sha256(key).slice(0, 8), 16) / 0x1_0000_0000;
  return bucket < holdoutFraction ? 'holdout' : 'tune';
}

export function selectSplit(examples: Example[], holdoutFraction: number, split: Split | 'all'): Example[] {
  if (split === 'all') return examples;
  return examples.filter((example) => splitOf(example, holdoutFraction) === split);
}
