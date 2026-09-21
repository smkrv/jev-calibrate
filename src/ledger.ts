import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const STATE_DIR = '.jev-calibrate';
const LEDGER_FILE = 'ledger.jsonl';

/** One holdout check of one question. Meant to be committed: it is the record of what the holdout has seen. */
export type LedgerEntry = {
  at: string;
  question: string;
  revision: string;
  model: string;
  /** Short hashes of the holdout examples that were judged. */
  seen: string[];
};

export function readLedger(dir: string): LedgerEntry[] {
  const file = path.join(dir, STATE_DIR, LEDGER_FILE);
  if (!existsSync(file)) return [];
  const entries: LedgerEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as LedgerEntry;
      if (typeof entry.question === 'string' && typeof entry.revision === 'string' && Array.isArray(entry.seen)) entries.push(entry);
    } catch {
      // A damaged line loses one record; refusing to run over it would lose the whole check.
    }
  }
  return entries;
}

export function appendLedger(dir: string, entries: LedgerEntry[]): void {
  if (entries.length === 0) return;
  mkdirSync(path.join(dir, STATE_DIR), { recursive: true });
  appendFileSync(path.join(dir, STATE_DIR, LEDGER_FILE), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
}

/**
 * A holdout example that has judged an earlier revision has already informed a change,
 * which makes it development data. The count of such examples is the honest caveat on
 * the holdout number; the remedy is fresh examples, not a flag that hides the warning.
 */
export function holdoutWarnings(
  ledger: LedgerEntry[],
  current: { question: string; revision: string; seen: string[] }[],
): string[] {
  const warnings: string[] = [];
  for (const now of current) {
    const earlier = ledger.filter((entry) => entry.question === now.question && entry.revision !== now.revision);
    if (earlier.length === 0) continue;
    const used = new Set(earlier.flatMap((entry) => entry.seen));
    const reused = now.seen.filter((hash) => used.has(hash)).length;
    if (reused === 0) continue;
    const revisions = new Set(earlier.map((entry) => entry.revision)).size;
    warnings.push(
      `${now.question}: ${reused} of ${now.seen.length} holdout examples already judged ${revisions} earlier revision${revisions === 1 ? '' : 's'}. ` +
        `They have informed a change, so the numbers on them are optimistic. Fresh examples: ${now.seen.length - reused}.`,
    );
  }
  return warnings;
}
