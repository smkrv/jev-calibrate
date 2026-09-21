import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXAMPLES_FILE, QUESTIONS_FILE } from './project.ts';

const QUESTIONS = {
  questions: {
    refund_requested: {
      type: 'noul',
      instructions: 'The customer asks for money to be returned.',
      criteria: {
        true: 'The message asks for a refund, a chargeback, or the reversal of a charge that was already made.',
        false: 'No request to return money: the customer reports a problem, asks a question, or only wants future billing to stop.',
      },
    },
    owner: {
      type: 'choice',
      instructions: 'Which team should handle this message?',
      criteria: {
        billing: 'Charges, invoices, payment methods, refunds, plan prices.',
        technical: 'Bugs, errors, outages, integrations, performance.',
        other: 'Neither of the above, or the message does not say enough to tell.',
      },
    },
  },
  decisions: { refund_requested: { threshold: 0.5 } },
  settings: { holdoutFraction: 0.5, minPerClass: 5 },
};

const EXAMPLES = [
  { id: 'sample-1', state: 'I was charged twice this month. Please return the second payment.', labels: { refund_requested: true, owner: 'billing' } },
  { id: 'sample-2', state: 'The export button does nothing since this morning.', labels: { refund_requested: false, owner: 'technical' } },
];

/** Never overwrites: an existing file is somebody's work. */
export function init(dir: string): { written: string[]; skipped: string[] } {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const skipped: string[] = [];
  const files: [string, string][] = [
    [QUESTIONS_FILE, `${JSON.stringify(QUESTIONS, null, 2)}\n`],
    [EXAMPLES_FILE, EXAMPLES.map((example) => `${JSON.stringify(example)}\n`).join('')],
  ];
  for (const [name, content] of files) {
    const target = path.join(dir, name);
    if (existsSync(target)) skipped.push(name);
    else {
      writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
      written.push(name);
    }
  }
  return { written, skipped };
}
