import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS } from './types.ts';
import type { Decision, Example, Issue, Label, Project, Question, Settings, Split } from './types.ts';

export const QUESTIONS_FILE = 'questions.json';
export const EXAMPLES_FILE = 'examples.jsonl';

export class ProjectError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Names that would reach Object.prototype when used as a key of a plain object, inherited ones such as toString included. */
export function isSafeKey(key: string): boolean {
  return key !== 'prototype' && !(key in Object.prototype);
}

function parseQuestion(id: string, raw: unknown, issues: Issue[]): Question | undefined {
  const where = `${QUESTIONS_FILE}: ${id}`;
  const fail = (message: string): undefined => {
    issues.push({ level: 'error', code: 'question-shape', message, where });
    return undefined;
  };
  if (!isSafeKey(id)) return fail('this name is reserved and cannot be a question id');
  if (!isRecord(raw)) return fail('a question must be an object');
  if (!isNonEmptyString(raw.instructions)) return fail('"instructions" must be a non-empty string');
  const instructions = raw.instructions;

  if (raw.type === 'noul') {
    if (raw.criteria === undefined) return { type: 'noul', instructions };
    const criteria = raw.criteria;
    if (!isRecord(criteria) || !isNonEmptyString(criteria.true) || !isNonEmptyString(criteria.false)) {
      return fail('noul "criteria" must be an object with non-empty "true" and "false" strings');
    }
    return { type: 'noul', instructions, criteria: { true: criteria.true, false: criteria.false } };
  }
  if (raw.type === 'choice') {
    const criteria = raw.criteria;
    if (!isRecord(criteria)) return fail('choice "criteria" must map each option to its description');
    const options = Object.entries(criteria);
    if (options.length < 2) return fail('a choice needs at least two options');
    if (options.length > 255) return fail('a choice takes at most 255 options');
    for (const [option, description] of options) {
      if (!isSafeKey(option)) return fail(`"${option}" is a reserved name and cannot be an option`);
      if (!isNonEmptyString(description)) return fail(`option "${option}" needs a non-empty description`);
    }
    return { type: 'choice', instructions, criteria: criteria as Record<string, string> };
  }
  if (raw.type === 'score') {
    const criteria = raw.criteria;
    if (!Array.isArray(criteria) || criteria.length < 2 || !criteria.every(isNonEmptyString)) {
      return fail('score "criteria" must be an array of at least two non-empty level descriptions');
    }
    return { type: 'score', instructions, criteria: criteria as string[] };
  }
  return fail('"type" must be "noul", "choice" or "score"');
}

function parseDecision(id: string, raw: unknown, issues: Issue[]): Decision | undefined {
  const where = `${QUESTIONS_FILE}: decisions.${id}`;
  if (!isRecord(raw)) {
    issues.push({ level: 'error', code: 'decision-shape', message: 'a decision must be an object', where });
    return undefined;
  }
  const decision: Decision = {};
  for (const key of ['threshold', 'minConfidence'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
      issues.push({ level: 'error', code: 'decision-shape', message: `"${key}" must be a number from 0 to 1`, where });
      continue;
    }
    decision[key] = value;
  }
  return decision;
}

function parseSettings(raw: unknown, issues: Issue[]): Settings {
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    targets: { ...DEFAULT_SETTINGS.targets },
    escapeOptions: [...DEFAULT_SETTINGS.escapeOptions],
  };
  if (raw === undefined) return settings;
  const where = `${QUESTIONS_FILE}: settings`;
  const bad = (message: string): void => {
    issues.push({ level: 'error', code: 'settings-shape', message, where });
  };
  if (!isRecord(raw)) {
    bad('"settings" must be an object');
    return settings;
  }
  if (raw.model !== undefined) {
    if (isNonEmptyString(raw.model)) settings.model = raw.model;
    else bad('"model" must be a non-empty string');
  }
  if (raw.holdoutFraction !== undefined) {
    const value = raw.holdoutFraction;
    if (typeof value === 'number' && value > 0 && value < 1) settings.holdoutFraction = value;
    else bad('"holdoutFraction" must be a number between 0 and 1, both excluded');
  }
  if (raw.minPerClass !== undefined) {
    const value = raw.minPerClass;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1) settings.minPerClass = value;
    else bad('"minPerClass" must be a positive integer');
  }
  if (raw.escapeOptions !== undefined) {
    if (Array.isArray(raw.escapeOptions) && raw.escapeOptions.every(isNonEmptyString)) {
      settings.escapeOptions = raw.escapeOptions as string[];
    } else bad('"escapeOptions" must be an array of strings');
  }
  if (raw.targets !== undefined) {
    if (!isRecord(raw.targets)) bad('"targets" must be an object');
    else {
      for (const key of Object.keys(settings.targets) as (keyof Settings['targets'])[]) {
        const value = raw.targets[key];
        if (value === undefined) continue;
        if (typeof value === 'number' && value > 0 && value <= 1) settings.targets[key] = value;
        else bad(`"targets.${key}" must be a number above 0 and at most 1`);
      }
    }
  }
  return settings;
}

/**
 * A state file must stay inside the project: an examples file is data, and whatever it
 * names is sent to the provider. Symlinks are resolved first, because a cloned project can
 * carry a link that points at a key file elsewhere on the disk.
 */
function readStateFile(dir: string, relative: string): string {
  const root = realpathSync(path.resolve(dir));
  let target: string;
  try {
    target = realpathSync(path.resolve(root, relative));
  } catch {
    throw new ProjectError(`state_file "${relative}" cannot be read`);
  }
  if (!target.startsWith(root + path.sep)) {
    throw new ProjectError(`state_file "${relative}" points outside the project directory`);
  }
  return readFileSync(target, 'utf8');
}

function parseExample(dir: string, line: string, lineNumber: number, issues: Issue[]): Example | undefined {
  const where = `${EXAMPLES_FILE}:${lineNumber}`;
  const fail = (message: string): undefined => {
    issues.push({ level: 'error', code: 'example-shape', message, where });
    return undefined;
  };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return fail('not valid JSON');
  }
  if (!isRecord(raw)) return fail('an example must be a JSON object');
  if (!isNonEmptyString(raw.id)) return fail('"id" must be a non-empty string');

  let state: string;
  if (isNonEmptyString(raw.state)) state = raw.state;
  else if (isNonEmptyString(raw.state_file)) {
    try {
      state = readStateFile(dir, raw.state_file);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (state.trim().length === 0) return fail(`state_file "${raw.state_file}" is empty`);
  } else return fail('an example needs a non-empty "state" or a "state_file"');

  if (!isRecord(raw.labels) || Object.keys(raw.labels).length === 0) {
    return fail('"labels" must map at least one question id to its expected answer');
  }
  const labels: Record<string, Label> = {};
  for (const [question, label] of Object.entries(raw.labels)) {
    if (!isSafeKey(question)) return fail(`"${question}" is a reserved name and cannot be a question id`);
    if (typeof label !== 'boolean' && typeof label !== 'string' && typeof label !== 'number') {
      return fail(`label for "${question}" must be a boolean, a string or a number`);
    }
    labels[question] = label;
  }

  const example: Example = { id: raw.id, state, labels };
  if (raw.group !== undefined) {
    if (!isNonEmptyString(raw.group)) return fail('"group" must be a non-empty string');
    example.group = raw.group;
  }
  if (raw.split !== undefined) {
    if (raw.split !== 'tune' && raw.split !== 'holdout') return fail('"split" must be "tune" or "holdout"');
    example.split = raw.split as Split;
  }
  return example;
}

/**
 * Reads a project directory. Unreadable or unparseable top-level files throw; everything
 * a person can fix line by line comes back as issues next to whatever could be loaded.
 */
export function loadProject(dir: string): { project: Project; issues: Issue[] } {
  const issues: Issue[] = [];
  const questionsPath = path.join(dir, QUESTIONS_FILE);
  const examplesPath = path.join(dir, EXAMPLES_FILE);

  let rawQuestions: unknown;
  try {
    rawQuestions = JSON.parse(readFileSync(questionsPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProjectError(`cannot read ${questionsPath}: ${reason}`);
  }
  if (!isRecord(rawQuestions) || !isRecord(rawQuestions.questions)) {
    throw new ProjectError(`${questionsPath} must be an object with a "questions" map`);
  }

  const questions: Record<string, Question> = {};
  for (const [id, raw] of Object.entries(rawQuestions.questions)) {
    const question = parseQuestion(id, raw, issues);
    if (question) questions[id] = question;
  }

  const decisions: Record<string, Decision> = {};
  if (rawQuestions.decisions !== undefined) {
    if (!isRecord(rawQuestions.decisions)) {
      issues.push({ level: 'error', code: 'decision-shape', message: '"decisions" must be an object', where: QUESTIONS_FILE });
    } else {
      for (const [id, raw] of Object.entries(rawQuestions.decisions)) {
        if (!isSafeKey(id)) {
          issues.push({ level: 'error', code: 'decision-shape', message: `"${id}" is a reserved name and cannot be a question id`, where: `${QUESTIONS_FILE}: decisions` });
          continue;
        }
        const decision = parseDecision(id, raw, issues);
        if (decision) decisions[id] = decision;
      }
    }
  }

  const settings = parseSettings(rawQuestions.settings, issues);

  let examplesText: string;
  try {
    examplesText = readFileSync(examplesPath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ProjectError(`cannot read ${examplesPath}: ${reason}`);
  }
  const examples: Example[] = [];
  examplesText.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return;
    const example = parseExample(dir, line, index + 1, issues);
    if (example) examples.push(example);
  });

  return { project: { dir, questions, decisions, settings, examples }, issues };
}
