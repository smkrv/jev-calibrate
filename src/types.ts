/** A yes/no question. The answer is the probability of "yes". */
export type NoulQuestion = {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
};

/** Pick one labelled option. Keys of `criteria` are the options. */
export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
};

/** Ordered levels. Labels and answers use the zero-based level index, as the API legend does. */
export type ScoreQuestion = {
  type: 'score';
  instructions: string;
  criteria: string[];
};

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Expected answer: boolean for noul, option key for choice, level index for score. */
export type Label = boolean | string | number;

export type Split = 'tune' | 'holdout';

export type Example = {
  id: string;
  state: string;
  labels: Record<string, Label>;
  /** Examples that share a group stay in one split and are compared with each other. */
  group?: string;
  /** Overrides the hash-based assignment. */
  split?: Split;
};

/** The operating point of a question. Part of its revision: changing it after a holdout run is tuning. */
export type Decision = {
  /** noul: answer counts as "yes" at or above this probability. Default 0.5. */
  threshold?: number;
  /** choice and score: answers below this confidence go to review instead of being acted on. */
  minConfidence?: number;
};

export type Targets = {
  precision: number;
  recall: number;
  auc: number;
  accuracy: number;
  /** Smallest share of answers that must stay automatic when a confidence cutoff is used. */
  coverage: number;
};

export type Settings = {
  model?: string;
  holdoutFraction: number;
  minPerClass: number;
  targets: Targets;
  escapeOptions: string[];
};

export type Project = {
  dir: string;
  questions: Record<string, Question>;
  decisions: Record<string, Decision>;
  settings: Settings;
  examples: Example[];
};

export type NoulAnswer = { type: 'noul'; noul: number };
export type ChoiceAnswer = {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: 'score';
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
};
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export type Issue = {
  level: 'error' | 'warning';
  code: string;
  message: string;
  where?: string;
};

export const DEFAULT_SETTINGS: Settings = {
  holdoutFraction: 0.5,
  minPerClass: 5,
  targets: { precision: 0.9, recall: 0.8, auc: 0.85, accuracy: 0.9, coverage: 0.5 },
  escapeOptions: ['other', 'none', 'unknown', 'unsure', 'unclear', 'not_applicable', 'insufficient_evidence'],
};
