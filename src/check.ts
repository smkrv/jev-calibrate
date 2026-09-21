import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isPlainRemote, resolveProvider } from './client.ts';
import type { FetchLike, ProviderOptions } from './client.ts';
import { revisionOf, sha256 } from './hash.ts';
import { appendLedger, holdoutWarnings, readLedger, STATE_DIR } from './ledger.ts';
import { buildReport } from './report.ts';
import type { Report } from './report.ts';
import { questionsFor, runExamples } from './run.ts';
import type { RunOptions } from './run.ts';
import { selectSplit } from './split.ts';
import { ProjectError } from './project.ts';
import type { Project, Split } from './types.ts';

export const VERSION = '0.1.11';

export type CheckOptions = ProviderOptions & {
  split: Split | 'all';
  runs: number;
  concurrency?: number;
  only?: string[];
  /** Write the run file and, on holdout, the ledger. Off for dry library use and tests. */
  persist?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  onProgress?: (done: number, total: number) => void;
};

const seenHash = (id: string, state: string): string => sha256(`${id}\n${state}`).slice(0, 10);

export async function check(project: Project, options: CheckOptions): Promise<{ report: Report; runFile?: string }> {
  const providerOptions: ProviderOptions = {};
  if (options.provider) providerOptions.provider = options.provider;
  if (options.baseUrl) providerOptions.baseUrl = options.baseUrl;
  const model = options.model ?? project.settings.model;
  if (model) providerOptions.model = model;
  const provider = resolveProvider(options.env ?? process.env, providerOptions);

  const examples = selectSplit(project.examples, project.settings.holdoutFraction, options.split);
  const persist = options.persist ?? true;

  const warnings: string[] = [];
  if (isPlainRemote(provider.endpoint)) {
    warnings.push(`the API key is sent without encryption to ${new URL(provider.endpoint).host}: use https unless that host is yours`);
  }
  if (options.split === 'all') {
    warnings.push('split "all" mixes tune and holdout examples: use it to look around, not to report a result. The held-out examples it judges are recorded as seen.');
  }
  if (options.split !== 'tune') {
    const current = Object.keys(project.questions)
      .filter((id) => !options.only || options.only.includes(id))
      .map((id) => ({
        question: id,
        seen: selectSplit(examples, project.settings.holdoutFraction, 'holdout')
          .filter((example) => Object.hasOwn(questionsFor(project, example, options.only), id))
          .map((example) => seenHash(example.id, example.state)),
      }))
      .filter((entry) => entry.seen.length > 0);
    const withRevision = current.map((entry) => ({
      ...entry,
      revision: revisionOf(project.questions[entry.question], project.decisions[entry.question] ?? {}),
    }));
    warnings.push(...holdoutWarnings(readLedger(project.dir), withRevision));
  }

  const runOptions: RunOptions = { runs: options.runs, concurrency: options.concurrency ?? 8 };
  if (options.only) runOptions.only = options.only;
  if (options.onProgress) runOptions.onProgress = options.onProgress;
  const run = await runExamples(project, examples, provider, runOptions, options.fetchImpl);

  const meta: Parameters<typeof buildReport>[3] = {
    version: VERSION, split: options.split, runs: options.runs, provider: provider.name, model: provider.model, warnings,
  };
  if (options.only) meta.only = options.only;
  const report = buildReport(project, examples, run, meta);

  if (!persist) return { report };

  // Every look at a held-out example is recorded, including the ones taken through "all":
  // otherwise that split would be a way around the ledger.
  const heldOut = new Map(selectSplit(examples, project.settings.holdoutFraction, 'holdout').map((example) => [example.id, example]));
  if (heldOut.size > 0) {
    appendLedger(
      project.dir,
      report.questions
        .map((question) => ({
          at: report.createdAt,
          question: question.id,
          revision: question.revision,
          model: report.modelsAnswered.join(',') || report.modelRequested,
          seen: question.outcomes.flatMap((outcome) => {
            const example = heldOut.get(outcome.id);
            return example ? [seenHash(example.id, example.state)] : [];
          }),
        }))
        .filter((entry) => entry.seen.length > 0),
    );
  }
  const runsDir = path.join(project.dir, STATE_DIR, 'runs');
  mkdirSync(runsDir, { recursive: true });
  // File names sort by time, which "compare" relies on. Two runs in the same millisecond
  // would share a name, so the stamp moves forward until the name is free: an earlier
  // run is never overwritten.
  const started = Date.parse(report.createdAt);
  for (let offset = 0; ; offset += 1) {
    const stamp = new Date(started + offset).toISOString().replace(/[:.]/g, '-');
    const runFile = path.join(runsDir, `${stamp}-${options.split}.json`);
    try {
      writeFileSync(runFile, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return { report, runFile };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export function readReport(file: string): Report {
  let parsed: Report;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Report;
  } catch (error) {
    throw new ProjectError(`cannot read run file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const wellFormed =
    parsed !== null && typeof parsed === 'object' && parsed.tool === 'jev-calibrate' && Array.isArray(parsed.questions) &&
    Array.isArray(parsed.modelsAnswered) &&
    parsed.questions.every((question) => typeof question?.id === 'string' && Array.isArray(question.outcomes));
  if (!wellFormed) throw new ProjectError(`${file} is not a jev-calibrate run file`);
  return parsed;
}

/** The two most recent run files of a split, oldest first. File names start with a timestamp, so they sort by time. */
export function latestRuns(dir: string, split: Split | 'all'): [string, string] | undefined {
  const runsDir = path.join(dir, STATE_DIR, 'runs');
  let files: string[];
  try {
    files = readdirSync(runsDir).filter((name) => name.endsWith(`-${split}.json`)).sort();
  } catch {
    return undefined;
  }
  if (files.length < 2) return undefined;
  return [path.join(runsDir, files[files.length - 2] as string), path.join(runsDir, files[files.length - 1] as string)];
}
