import { ask } from './client.ts';
import type { FetchLike, Provider } from './client.ts';
import { sha256 } from './hash.ts';
import { labelProblem } from './lint.ts';
import type { Answer, Example, Label, Project, Question } from './types.ts';

export type RawExample = {
  id: string;
  /** Hash instead of the text: a run file should not become a second copy of your data. */
  stateHash: string;
  group?: string;
  /** One answer per run, in run order. */
  answers: Record<string, Answer[]>;
  /** Set when any request for this example failed. Such an example is "not checked", never "wrong". */
  error?: string;
  /** Questions that came back missing or malformed in any run. Only those questions lose the example. */
  failed?: Record<string, string>;
};

export type RawRun = {
  examples: RawExample[];
  requests: number;
  costUsd?: number;
  models: string[];
  seconds: number;
};

export type RunOptions = {
  runs: number;
  concurrency: number;
  /** Restrict the check to these question ids. */
  only?: string[];
  onProgress?: (done: number, total: number) => void;
};

/** Questions an example can be scored on: labelled, known, with a label of the right kind. */
export function questionsFor(project: Project, example: Example, only?: string[]): Record<string, Question> {
  const selected: Record<string, Question> = {};
  for (const [id, label] of Object.entries(example.labels)) {
    const question = Object.hasOwn(project.questions, id) ? project.questions[id] : undefined;
    if (!question || (only && !only.includes(id))) continue;
    if (labelProblem(question, label as Label)) continue;
    selected[id] = question;
  }
  return selected;
}

export async function runExamples(
  project: Project,
  examples: Example[],
  provider: Provider,
  options: RunOptions,
  fetchImpl?: FetchLike,
): Promise<RawRun> {
  const started = Date.now();
  const prepared = examples
    .map((example) => ({ example, questions: questionsFor(project, example, options.only) }))
    .filter((entry) => Object.keys(entry.questions).length > 0);

  const results = new Map<string, RawExample>();
  for (const { example, questions } of prepared) {
    const raw: RawExample = {
      id: example.id,
      stateHash: sha256(example.state).slice(0, 16),
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, [] as Answer[]])),
    };
    if (example.group) raw.group = example.group;
    results.set(example.id, raw);
  }

  const tasks = prepared.flatMap((entry) => Array.from({ length: options.runs }, (_, run) => ({ ...entry, run })));
  const perRun = new Map<string, Record<string, Answer>[]>();
  const models = new Set<string>();
  let cost: number | undefined;
  let requests = 0;
  let done = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      if (!task) break;
      const raw = results.get(task.example.id) as RawExample;
      try {
        requests += 1;
        const result = await ask(provider, task.example.state, task.questions, fetchImpl);
        models.add(result.model);
        if (result.costUsd !== undefined) cost = (cost ?? 0) + result.costUsd;
        for (const [questionId, reason] of Object.entries(result.failures)) {
          raw.failed ??= {};
          raw.failed[questionId] ??= reason;
        }
        const slots = perRun.get(task.example.id) ?? [];
        slots[task.run] = result.answers;
        perRun.set(task.example.id, slots);
      } catch (error) {
        raw.error ??= error instanceof Error ? error.message : String(error);
      }
      done += 1;
      options.onProgress?.(done, tasks.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, tasks.length)) }, worker));

  for (const [id, slots] of perRun) {
    const raw = results.get(id) as RawExample;
    if (raw.error) continue;
    for (const answers of slots) {
      for (const [questionId, answer] of Object.entries(answers ?? {})) {
        // A question that failed in one run is dropped for this example in all of them:
        // an average over fewer runs than its neighbours would not be comparable.
        if (raw.failed && Object.hasOwn(raw.failed, questionId)) continue;
        raw.answers[questionId]?.push(answer);
      }
    }
  }

  const run: RawRun = {
    examples: [...results.values()],
    requests,
    models: [...models].sort(),
    seconds: (Date.now() - started) / 1000,
  };
  if (cost !== undefined) run.costUsd = cost;
  return run;
}
