import type { Answer, Question } from './types.ts';

export const INPUT_PRICE_PER_MILLION_USD = 0.042;

export type Provider = {
  name: string;
  endpoint: string;
  model: string;
  /** Never logged, never written to a run file. */
  key: string;
};

export type ProviderOptions = {
  provider?: string;
  model?: string;
  baseUrl?: string;
};

export type AskResult = {
  model: string;
  answers: Record<string, Answer>;
  /** Questions whose answer was missing or malformed. The other answers of the request stay usable. */
  failures: Record<string, string>;
  inputTokens?: number;
  costUsd?: number;
};

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class JevError extends Error {}

const TYPESAFE = { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-1.13.0', env: 'TYPESAFE_API_KEY' };
const OPENROUTER = { endpoint: 'https://openrouter.ai/api/alpha/decisions', model: 'typesafe/jev-1.13', env: 'OPENROUTER_API_KEY' };

/**
 * Pinned model versions are the default on purpose: thresholds belong to a build, and an
 * alias can move to the next one without any change on the caller's side.
 */
/** True when the key would travel unencrypted to a host other than this machine. */
export function isPlainRemote(endpoint: string): boolean {
  const url = new URL(endpoint);
  return url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function resolveProvider(env: Record<string, string | undefined>, options: ProviderOptions = {}): Provider {
  const wanted = options.provider ?? (env.TYPESAFE_API_KEY ? 'typesafe' : env.OPENROUTER_API_KEY ? 'openrouter' : undefined);
  if (wanted !== 'typesafe' && wanted !== 'openrouter') {
    if (wanted !== undefined) throw new JevError(`unknown provider "${wanted}"; use "typesafe" or "openrouter"`);
    throw new JevError('no API key: set TYPESAFE_API_KEY or OPENROUTER_API_KEY in the environment');
  }
  const preset = wanted === 'typesafe' ? TYPESAFE : OPENROUTER;
  const key = env[preset.env];
  if (!key) throw new JevError(`provider "${wanted}" needs ${preset.env} in the environment`);

  let endpoint = preset.endpoint;
  const baseUrl = options.baseUrl ?? (wanted === 'typesafe' ? env.TYPESAFE_BASE_URL : undefined);
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new JevError(`base URL "${baseUrl}" is not a valid URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new JevError('base URL must start with https:// or http://');
    }
    // Built from the parsed URL: a "#" or "?" in the raw string would otherwise swallow the API path.
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') + new URL(preset.endpoint).pathname;
    parsed.search = '';
    parsed.hash = '';
    endpoint = parsed.toString();
  }
  return { name: wanted, endpoint, model: options.model ?? preset.model, key };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function isDistribution(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isProbability);
}

/** A response is trusted only after its shape matches the question it answers. */
export function parseAnswer(question: Question, raw: unknown): Answer {
  if (!isRecord(raw)) throw new JevError('answer is not an object');
  if (question.type === 'noul') {
    if (!isProbability(raw.noul)) throw new JevError('noul answer has no probability');
    return { type: 'noul', noul: raw.noul };
  }
  if (!isDistribution(raw.probabilities) || !isProbability(raw.confidence)) {
    throw new JevError(`${question.type} answer has no distribution or confidence`);
  }
  // An empty or foreign distribution would later read as "level 0" or as an unknown option.
  const offered = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, level) => String(level));
  const returned = Object.keys(raw.probabilities);
  if (returned.length === 0 || returned.some((key) => !offered.includes(key))) {
    throw new JevError(`${question.type} distribution does not match the offered ${question.type === 'choice' ? 'options' : 'levels'}`);
  }
  if (question.type === 'choice') {
    if (typeof raw.choice !== 'string' || !Object.hasOwn(question.criteria, raw.choice)) {
      throw new JevError('choice answer names an option that was not offered');
    }
    return { type: 'choice', choice: raw.choice, probabilities: raw.probabilities, confidence: raw.confidence };
  }
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) throw new JevError('score answer has no score');
  // A score is a position on the levels. One past either end would reach the report as an error of many levels.
  if (raw.score < 0 || raw.score > question.criteria.length - 1) throw new JevError('score is outside the offered levels');
  return { type: 'score', score: raw.score, probabilities: raw.probabilities, confidence: raw.confidence };
}

const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 60_000;

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 30) * 1000;
  return 500 * 2 ** attempt + Math.random() * 250;
}

/**
 * One request: one state, several independent questions. Overload (429, 5xx) and network
 * failures are retried; any other status is final, because repeating it cannot help.
 */
export async function ask(
  provider: Provider,
  state: string,
  questions: Record<string, Question>,
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<AskResult> {
  const body = JSON.stringify({ model: provider.model, state, questions });
  let lastError = 'no attempt made';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(provider.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' },
        body,
        // A followed 307 would send the state again, to a host nobody named.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      lastError = `network: ${error instanceof Error ? error.message : String(error)}`;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(retryDelayMs(attempt, null));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = `HTTP ${response.status}`;
      // An unread body keeps its connection out of the pool until it is collected.
      await response.body?.cancel().catch(() => {});
      if (attempt < MAX_ATTEMPTS - 1) await sleep(retryDelayMs(attempt, response.headers.get('retry-after')));
      continue;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = (response.headers.get('location') ?? 'an unnamed address').slice(0, 200);
      throw new JevError(`HTTP ${response.status}: redirect to ${location} not followed`);
    }
    const text = await response.text();
    if (!response.ok) throw new JevError(`HTTP ${response.status}: ${text.slice(0, 300)}`);

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new JevError('response is not JSON');
    }
    if (!isRecord(payload) || !isRecord(payload.answers)) throw new JevError('response has no "answers"');
    const answers: Record<string, Answer> = {};
    const failures: Record<string, string> = {};
    for (const [id, question] of Object.entries(questions)) {
      try {
        answers[id] = parseAnswer(question, Object.hasOwn(payload.answers, id) ? payload.answers[id] : undefined);
      } catch (error) {
        failures[id] = error instanceof Error ? error.message : String(error);
      }
    }
    // The model name ends up in the ledger, which is committed: keep it short.
    const model = typeof payload.model === 'string' && payload.model.length > 0 ? payload.model.slice(0, 200) : provider.model;
    const result: AskResult = { model, answers, failures };
    if (isRecord(payload.usage)) {
      if (typeof payload.usage.input_tokens === 'number') {
        result.inputTokens = payload.usage.input_tokens;
        result.costUsd = (payload.usage.input_tokens / 1_000_000) * INPUT_PRICE_PER_MILLION_USD;
      }
      if (typeof payload.usage.cost === 'number') result.costUsd = payload.usage.cost;
    }
    return result;
  }
  throw new JevError(`gave up after ${MAX_ATTEMPTS} attempts (${lastError})`);
}
