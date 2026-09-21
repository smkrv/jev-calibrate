#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { check, latestRuns, readReport, VERSION } from './check.ts';
import { JevError } from './client.ts';
import { compareReports, renderComparison } from './compare.ts';
import { init } from './init.ts';
import { lintProject } from './lint.ts';
import { plain } from './plain.ts';
import { loadProject, ProjectError } from './project.ts';
import { belowRequirement, renderReport, REQUIRABLE } from './report.ts';
import { questionsFor } from './run.ts';
import { selectSplit } from './split.ts';
import type { Issue } from './types.ts';

const HELP = `jev-calibrate ${VERSION}

Usage
  jev-calibrate init                  write a starter questions.json and examples.jsonl
  jev-calibrate lint                  check the project without calling the API
  jev-calibrate check                 judge the tune examples and report per question
  jev-calibrate check --split holdout confirm a frozen revision on the held-out examples
  jev-calibrate compare [a] [b]       what changed between two runs (default: the last two tune runs)

Options
  --dir <path>          project directory (default: current directory)
  --split <name>        tune (default), holdout, or all
  --runs <n>            repeat every request n times; answers are averaged, spread is reported (default 1)
  --question <id>       check only this question; repeatable
  --provider <name>     typesafe or openrouter (default: whichever key is set, typesafe first)
  --model <id>          model id to request (default: a pinned version for the provider)
  --base-url <url>      API-compatible server, for the typesafe provider
  --concurrency <n>     parallel requests (default 8)
  --require <verdict>   exit 1 unless every question is at least: gate, gate-above-confidence, or ranker
  --strict              lint: treat warnings as errors
  --json                print the report as JSON

Keys come from TYPESAFE_API_KEY or OPENROUTER_API_KEY. Example states are sent to that provider.

Exit codes: 0 done, 1 requirement or lint failed, 2 some examples could not be checked or the command failed.`;



function printIssues(issues: Issue[]): void {
  for (const issue of issues) {
    const where = issue.where ? `${issue.where}: ` : '';
    console.error(plain(`${issue.level} [${issue.code}] ${where}${issue.message}`));
  }
}

function positiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ProjectError(`--${name} must be a positive integer`);
  return parsed;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: 'string', default: '.' },
      split: { type: 'string', default: 'tune' },
      runs: { type: 'string' },
      question: { type: 'string', multiple: true },
      provider: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      concurrency: { type: 'string' },
      require: { type: 'string' },
      strict: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  const command = positionals[0];
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || command === undefined) {
    console.log(HELP);
    return command === undefined && !values.help ? 1 : 0;
  }
  const dir = values.dir;
  const split = values.split;
  if (split !== 'tune' && split !== 'holdout' && split !== 'all') throw new ProjectError('--split must be tune, holdout or all');

  if (command === 'init') {
    const { written, skipped } = init(dir);
    for (const name of written) console.log(`wrote ${name}`);
    for (const name of skipped) console.log(`kept ${name}: it already exists`);
    return 0;
  }

  if (command === 'compare') {
    if (positionals.length !== 1 && positionals.length !== 3) throw new ProjectError('compare takes two run files, or none to use the last two runs');
    const files = positionals.length >= 3 ? ([positionals[1], positionals[2]] as [string, string]) : latestRuns(dir, split);
    if (!files) throw new ProjectError(`need two ${split} runs to compare; run "jev-calibrate check" before and after an edit`);
    const comparison = compareReports(readReport(files[0]), readReport(files[1]));
    console.log(values.json ? JSON.stringify(comparison, null, 2) : renderComparison(comparison));
    return comparison.questions.some((question) => question.regressed.length > 0) ? 1 : 0;
  }

  if (command !== 'lint' && command !== 'check') throw new ProjectError(`unknown command "${command}"; see --help`);

  const { project, issues: shapeIssues } = loadProject(dir);
  const issues = [...shapeIssues, ...lintProject(project)];
  const errors = issues.filter((issue) => issue.level === 'error');

  if (command === 'lint') {
    printIssues(issues);
    const warnings = issues.length - errors.length;
    console.log(`${Object.keys(project.questions).length} questions, ${project.examples.length} examples: ${errors.length} errors, ${warnings} warnings`);
    return errors.length > 0 || (values.strict && warnings > 0) ? 1 : 0;
  }

  if (errors.length > 0) {
    printIssues(errors);
    console.error('fix the errors above, or run "jev-calibrate lint" for the full list');
    return 1;
  }
  const required = REQUIRABLE.find((verdict) => verdict === values.require);
  if (values.require !== undefined && required === undefined) throw new ProjectError(`--require must be one of: ${REQUIRABLE.join(', ')}`);
  for (const id of values.question ?? []) {
    if (!Object.hasOwn(project.questions, id)) throw new ProjectError(`--question "${id}" is not in questions.json`);
  }

  const options: Parameters<typeof check>[1] = {
    split,
    runs: positiveInt(values.runs, 'runs', 1),
    concurrency: positiveInt(values.concurrency, 'concurrency', 8),
  };
  if (values.question) options.only = values.question;
  if (values.provider) options.provider = values.provider;
  if (values.model) options.model = values.model;
  if (values['base-url']) options.baseUrl = values['base-url'];
  if (process.stderr.isTTY && !values.json) {
    options.onProgress = (done, total) => process.stderr.write(`\rasked ${done}/${total}${done === total ? '\n' : ''}`);
  }

  // Said before the first request: a cloned project should not spend the key in silence.
  const planned = selectSplit(project.examples, project.settings.holdoutFraction, split).filter(
    (example) => Object.keys(questionsFor(project, example, options.only)).length > 0,
  );
  const characters = planned.reduce((sum, example) => sum + example.state.length, 0) * options.runs;
  if (!values.json) console.error(`${planned.length * options.runs} requests, about ${characters} characters of state`);

  const { report, runFile } = await check(project, options);
  console.log(values.json ? JSON.stringify(report, null, 2) : renderReport(report));
  if (runFile && !values.json) console.log(`\nrun file: ${runFile}`);

  if (report.notChecked.length > 0) return 2;
  if (required) {
    const below = belowRequirement(report, required);
    if (below.length > 0) {
      console.error(plain(`below "${required}": ${below.join(', ')}`));
      return 1;
    }
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ProjectError || error instanceof JevError) console.error(plain(`error: ${error.message}`));
    else console.error(error);
    process.exitCode = 2;
  },
);
