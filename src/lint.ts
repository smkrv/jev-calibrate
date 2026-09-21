import { EXAMPLES_FILE, QUESTIONS_FILE } from './project.ts';
import { splitOf } from './split.ts';
import type { Example, Issue, Label, Project, Question, Split } from './types.ts';

const LEAK_WINDOW = 5;
/** Roughly 32k tokens at three characters per token; past this the request is likely to be rejected. */
const STATE_CHAR_LIMIT = 96_000;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0);
}

function questionText(question: Question): string {
  if (question.type === 'score') return [question.instructions, ...question.criteria].join(' . ');
  if (question.type === 'choice') return [question.instructions, ...Object.values(question.criteria)].join(' . ');
  return [question.instructions, question.criteria?.true ?? '', question.criteria?.false ?? ''].join(' . ');
}

/** Label classes of a question, as strings: the buckets that each need examples. */
export function classesOf(question: Question): string[] {
  if (question.type === 'noul') return ['true', 'false'];
  if (question.type === 'choice') return Object.keys(question.criteria);
  return question.criteria.map((_, level) => String(level));
}

export function labelProblem(question: Question, label: Label): string | undefined {
  if (question.type === 'noul') {
    return typeof label === 'boolean' ? undefined : 'a noul label must be true or false';
  }
  if (question.type === 'choice') {
    if (typeof label !== 'string') return 'a choice label must be one of the option keys';
    return Object.hasOwn(question.criteria, label) ? undefined : `"${label}" is not an option; options: ${Object.keys(question.criteria).join(', ')}`;
  }
  if (typeof label !== 'number' || !Number.isInteger(label)) return 'a score label must be a zero-based level index';
  const last = question.criteria.length - 1;
  return label >= 0 && label <= last ? undefined : `level ${label} is out of range 0..${last}`;
}

/**
 * Text copied from an example into a question turns the check into a lookup: the number
 * then says the model can match a string, not that it recognises the property.
 */
function findLeak(question: Question, example: Example): string | undefined {
  const haystack = ` ${words(questionText(question)).join(' ')} `;
  const stateWords = words(example.state);
  if (stateWords.length < 3) return undefined;
  if (stateWords.length < LEAK_WINDOW) {
    const whole = stateWords.join(' ');
    return haystack.includes(` ${whole} `) ? whole : undefined;
  }
  for (let start = 0; start + LEAK_WINDOW <= stateWords.length; start += 1) {
    const window = stateWords.slice(start, start + LEAK_WINDOW).join(' ');
    if (haystack.includes(` ${window} `)) return window;
  }
  return undefined;
}

export function lintProject(project: Project): Issue[] {
  const issues: Issue[] = [];
  const { questions, decisions, settings, examples } = project;
  const error = (code: string, message: string, where?: string): void => {
    issues.push(where === undefined ? { level: 'error', code, message } : { level: 'error', code, message, where });
  };
  const warn = (code: string, message: string, where?: string): void => {
    issues.push(where === undefined ? { level: 'warning', code, message } : { level: 'warning', code, message, where });
  };

  if (Object.keys(questions).length === 0) error('no-questions', 'no valid questions to check', QUESTIONS_FILE);
  if (examples.length === 0) error('no-examples', 'no valid examples to check against', EXAMPLES_FILE);

  const seen = new Set<string>();
  for (const example of examples) {
    if (seen.has(example.id)) error('duplicate-id', `example id "${example.id}" is used more than once`, EXAMPLES_FILE);
    seen.add(example.id);
    for (const [questionId, label] of Object.entries(example.labels)) {
      const question = Object.hasOwn(questions, questionId) ? questions[questionId] : undefined;
      if (!question) {
        error('unknown-question', `example "${example.id}" labels "${questionId}", which is not a question`, EXAMPLES_FILE);
        continue;
      }
      const problem = labelProblem(question, label);
      if (problem) error('label-type', `example "${example.id}", question "${questionId}": ${problem}`, EXAMPLES_FILE);
    }
    if (example.state.length > STATE_CHAR_LIMIT) {
      warn('state-size', `example "${example.id}" is ${example.state.length} characters; a request holds about 32k tokens`, EXAMPLES_FILE);
    }
  }

  const splitByGroup = new Map<string, Split>();
  for (const example of examples) {
    if (!example.group) continue;
    const split = splitOf(example, settings.holdoutFraction);
    const known = splitByGroup.get(example.group);
    if (known && known !== split) {
      error('group-split', `group "${example.group}" is divided between tune and holdout by explicit "split" values`, EXAMPLES_FILE);
    }
    splitByGroup.set(example.group, split);
  }

  for (const [id, decision] of Object.entries(decisions)) {
    const question = Object.hasOwn(questions, id) ? questions[id] : undefined;
    if (!question) {
      error('unknown-question', `decisions.${id} does not match any question`, QUESTIONS_FILE);
      continue;
    }
    if (decision.threshold !== undefined && question.type !== 'noul') {
      warn('decision-unused', `decisions.${id}.threshold is ignored: "${id}" is a ${question.type} question`, QUESTIONS_FILE);
    }
    if (decision.minConfidence !== undefined && question.type === 'noul') {
      warn('decision-unused', `decisions.${id}.minConfidence is ignored: a noul answer carries no confidence field`, QUESTIONS_FILE);
    }
  }

  const escapes = new Set(settings.escapeOptions.map((option) => option.toLowerCase()));
  for (const [id, question] of Object.entries(questions)) {
    const where = `${QUESTIONS_FILE}: ${id}`;
    if (question.type === 'choice' && !Object.keys(question.criteria).some((option) => escapes.has(option.toLowerCase()))) {
      warn(
        'no-escape-option',
        `every answer must be one of ${Object.keys(question.criteria).join(', ')}; add an option such as "other" for inputs that fit none of them`,
        where,
      );
    }
    if (question.type === 'noul' && !question.criteria) {
      warn('no-criteria', 'no "criteria": describing what counts as true and as false is the part you tune', where);
    }

    const labelled = examples.filter((example) => Object.hasOwn(example.labels, id) && !labelProblem(question, example.labels[id] as Label));
    if (labelled.length === 0) {
      warn('no-labels', 'no example carries a label for this question, so it cannot be checked', where);
      continue;
    }

    for (const example of labelled) {
      const leak = findLeak(question, example);
      if (leak) warn('example-leak', `the question text repeats example "${example.id}": "${leak}"`, where);
    }

    for (const split of ['tune', 'holdout'] as const) {
      const inSplit = labelled.filter((example) => splitOf(example, settings.holdoutFraction) === split);
      const thin = classesOf(question)
        .map((name) => ({ name, count: inSplit.filter((example) => String(example.labels[id]) === name).length }))
        .filter((entry) => entry.count < settings.minPerClass);
      if (thin.length > 0) {
        const detail = thin.map((entry) => `${entry.name}: ${entry.count}`).join(', ');
        warn('few-examples', `${split} has fewer than ${settings.minPerClass} examples for ${detail}`, where);
      }
    }

    const labelByState = new Map<string, { id: string; label: string }>();
    for (const example of labelled) {
      const key = words(example.state).join(' ');
      const label = String(example.labels[id]);
      const first = labelByState.get(key);
      if (first && first.label !== label) {
        warn('conflicting-labels', `examples "${first.id}" and "${example.id}" have the same state and different labels`, where);
      } else if (!first) labelByState.set(key, { id: example.id, label });
    }
  }

  return issues;
}
