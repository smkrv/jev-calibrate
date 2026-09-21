# jev-calibrate

[![CI](https://github.com/smkrv/jev-calibrate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/smkrv/jev-calibrate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%2B-3fb950.svg)](#install)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-none-3fb950.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-erasable-3178c6.svg)](src)

Calibrate Jev questions against your own labels.

A Jev question can look right on the inputs you tried by hand and still fail on labelled data. On the example shipped in this repository the first draft of a `frustration` question got 18 of 26 labelled messages right, and four of its eight wrong answers came with a confidence of 0.94 or more. `jev-calibrate` is the loop that finds that out: you write the questions, label a set of examples, and it tells you for each question whether its answers can drive a decision on their own, can only be used to sort, or carry no usable signal.

Jev is the typed-decision model from TypeSafe: it takes a `state` and a set of questions (`noul`, `choice`, `score`) and returns probabilities instead of text. How well a question works depends on its wording, on your data and on the threshold you cut at, and none of the three can be read off a single good-looking answer.

Unofficial and not affiliated with TypeSafe. Written in TypeScript, no runtime dependencies. It talks to the TypeSafe API, to OpenRouter, or to any server that implements the same request format.

## What you get

```text
$ jev-calibrate check --runs 3
split tune, 3 runs, openrouter, typesafe/jev-1.13-20260917
29 examples checked, 0 not checked, 87 requests, 8.2 s, $0.00212

frustration  [score]  revision 62c3811812e4  no confidence cutoff
  verdict    gate
             accuracy 0.92 reaches the target 0.9 on every answer
  examples   0: 14, 1: 7, 2: 5
  accuracy   0.92, within one level 1.00, mean error 0.13 levels
  confidence 0.86 when right, 0.45 when wrong
  at >= 0.5  accuracy 1.00 on 21 answers (81%)
  at >= 0.7  accuracy 1.00 on 19 answers (73%)
  at >= 0.9  accuracy 1.00 on 17 answers (65%)
  stability  3 runs, largest spread 0.08, 0 changed verdicts
  misses     2
             t-010: expected 0, got 1, confidence 0.48
             t-047: expected 1, got 2, confidence 0.43
```

Every question ends in one of these verdicts:

| Verdict | Meaning | What to do with the question |
|---|---|---|
| `gate` | Precision and recall (noul) or accuracy (choice, score) reach your targets at the configured operating point | Act on the answer |
| `gate-above-confidence` | Accuracy reaches the target among answers at or above `minConfidence`, and enough answers clear that bar | Act on confident answers, send the rest to review |
| `ranker` | Positive examples score above negative ones (AUC reaches the target), but the configured threshold misses the targets | If the report suggests a threshold that reaches them, set it in `decisions` and check again. If none does, sort by the probability and review from the top; do not cut on it |
| `unusable` | Neither | Rewrite the question or drop it |
| `too-few-examples` | Fewer labelled examples than `minPerClass` requires | Label more before trusting any number above |

## Install

Node 20 or later.

```sh
git clone https://github.com/smkrv/jev-calibrate.git
cd jev-calibrate
npm install --ignore-scripts
npm run build
npm link
```

Set one key in the environment: `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. When both are set, TypeSafe is used unless you pass `--provider openrouter`.

To try it on the bundled example (66 labelled support messages, three questions, under one cent for the whole loop):

```sh
jev-calibrate lint  --dir examples/support-tickets
jev-calibrate check --dir examples/support-tickets --runs 3
```

`jev-calibrate init` writes a starter `questions.json` and `examples.jsonl` into the current directory. It never overwrites a file that exists.

## The two files

`questions.json` holds the questions in the same shape the API takes, plus the operating point of each one:

```json
{
  "questions": {
    "refund_requested": {
      "type": "noul",
      "instructions": "The customer asks for money to be returned.",
      "criteria": {
        "true": "The message asks for a refund, a chargeback, or the reversal of a charge that was already made, in any wording.",
        "false": "No request to return money: the customer reports a problem, asks a question, complains about a charge without asking for it back, or only wants future billing to stop."
      }
    },
    "owner": {
      "type": "choice",
      "instructions": "Which team should handle this message?",
      "criteria": {
        "billing": "Charges, invoices, receipts, payment methods, refunds, plan prices and discounts.",
        "technical": "Bugs, errors, crashes, outages, slow performance, broken integrations or API calls.",
        "other": "None of the above, or the message does not say enough to tell."
      }
    }
  },
  "decisions": {
    "refund_requested": { "threshold": 0.5 },
    "owner": { "minConfidence": 0.7 }
  },
  "settings": {
    "holdoutFraction": 0.5,
    "minPerClass": 5,
    "targets": { "precision": 0.9, "recall": 0.8, "auc": 0.85, "accuracy": 0.9, "coverage": 0.5 }
  }
}
```

`decisions` and `settings` are optional; the values above are the defaults, except `owner.minConfidence`, which has none. `settings.model` pins a model id.

`examples.jsonl` has one labelled example per line:

```json
{"id": "t-001", "state": "You charged my card after I downgraded. I want that money back.", "labels": {"refund_requested": true, "owner": "billing"}, "group": "downgrade"}
{"id": "t-002", "state": "You charged my card after I downgraded. Which plan am I on right now?", "labels": {"refund_requested": false, "owner": "billing"}, "group": "downgrade"}
```

- `labels` maps a question id to the expected answer: `true` or `false` for noul, an option key for choice, a zero-based level index for score (the same numbering as the `legend` in the API response). A question missing from `labels` is not asked for that example. Leave arguable cases unlabelled: a narrow question is measured on the examples where you are sure of the answer.
- `group` ties together examples that differ only in the property you label, such as a message with and without the refund request. Inside a group every `true` example should score above every `false` one, and the report counts how often it does. Grouped examples always land in the same split.
- `split` forces `"tune"` or `"holdout"`. Without it the split comes from a hash of the group or the id, so an example keeps its place on every machine and when other examples are added. The price is balance: on the first 64 bundled examples the hash put 23 in tune and 41 in holdout, and three classes came out too thin to check. `lint` names the thin classes; seven examples in the bundled file carry an explicit `split` for that reason.
- `state_file` instead of `state` reads the text from a file inside the project directory.

## The procedure

1. Run `jev-calibrate lint` until it reports no errors. It makes no API calls, so this step is free.
2. `jev-calibrate check` judges the tune half and lists the misses.
3. Read the misses and edit `criteria` only. With `instructions` left alone, two runs differ in one thing and `compare` can tell you what that thing did. Describe the situation; do not paste examples into the question. If the misses are in the right order and wrong only at the threshold, take the suggested threshold into `decisions` instead.
4. Check again and run `jev-calibrate compare`, which shows what the edit fixed and what it broke. It exits with 1 when anything regressed.
5. When the tune half looks right, stop editing and run `jev-calibrate check --split holdout`. That number is the one to report.

On the bundled example the first draft of the questions had one-word criteria (`"billing": "Billing"`, levels `"Low"`, `"Medium"`, `"High"`). Tune results before and after describing each option and level:

```text
$ jev-calibrate compare
owner  5e487346e2ab -> 7f9d9c9a4d33
  verdict    unusable -> gate
  accuracy   0.89 -> 1.00
  fixed      t-022, t-046, t-047
  regressed  none

frustration  73cb21452a27 -> 62c3811812e4
  verdict    unusable -> gate
  accuracy   0.69 -> 0.92
  fixed      t-021, t-023, t-040, t-042, t-049, t-062
  regressed  none
```

A confidence cutoff would not have rescued the draft. At a cutoff of 0.9 it still scored 0.76, because four of the eight misses came with a confidence of 0.94 or more.

The holdout half, judged once after the edit: `refund_requested` AUC 1.00 with no false positives in 30, `owner` 1.00, `frustration` 0.97. The example is an easy one, and the labels come from the same person who wrote the questions.

## The holdout keeps a record

A held-out example stops being held out the moment a failure on it changes your question. `check --split holdout` therefore appends what it judged to `.jev-calibrate/ledger.jsonl`: the question, its revision and short hashes of the examples. A revision is a hash of the question text together with its entry in `decisions`, so moving a threshold after a holdout run counts as a change too.

When you run the holdout again with a different revision, the report says how many of its examples have already judged an earlier one:

```text
warning: refund_requested: 37 of 37 holdout examples already judged 1 earlier revision. They have informed a change, so the numbers on them are optimistic. Fresh examples: 0.
```

The remedy is new labelled examples. There is no flag that silences the warning, and `--split all` is no way around it: the held-out examples it judges are recorded as well. The holdout report also never suggests a threshold or a confidence cutoff. Both are tuning, and they belong to the tune half.

Commit the ledger. Run files under `.jev-calibrate/runs/` stay local.

Two limits of the record. It is keyed by the example id together with its text, so renaming an example or editing its state makes it count as fresh again. And each entry is a 10-character hash of that id and text: it does not reveal the text, but anyone who has the ledger can confirm a guess about a short or enumerable state, so keep the ledger private when the states are.

## Repeated runs

Answers are not perfectly repeatable: on the same input the probability moves by a few hundredths between calls. `--runs 3` asks everything three times, averages the probabilities and reports the largest spread and the number of examples whose verdict changed between runs. An example that flips sits on your threshold; look at it before you trust the cut.

An example is averaged over all of its runs or not at all: a request that fails in any run drops the example from the whole check, because a mean over fewer runs than its neighbours would not be comparable. A higher `--runs` therefore also raises the chance of losing an example to a timeout.

## What lint checks

| Code | Level | What it catches |
|---|---|---|
| `question-shape`, `decision-shape`, `settings-shape`, `example-shape` | error | Files that do not match the formats above, with the line number for examples |
| `no-questions`, `no-examples` | error | Nothing valid left to check after the shape errors above |
| `label-type`, `unknown-question`, `duplicate-id` | error | A label that cannot be an answer to its question; a label for a question that does not exist; a repeated id |
| `group-split` | error | A group divided between tune and holdout by explicit `split` values |
| `no-escape-option` | warning | A choice where every input must be one of the listed options. Add `other`, or name your own escape options in `settings.escapeOptions` |
| `example-leak` | warning | Five or more consecutive words of an example inside the question text. The check would then measure string matching |
| `few-examples` | warning | A class with fewer than `minPerClass` examples in a split |
| `conflicting-labels` | warning | The same state labelled two ways |
| `no-criteria`, `no-labels`, `decision-unused`, `state-size` | warning | A noul without criteria; a question nobody labelled; a `threshold` on a choice or a `minConfidence` on a noul (a noul answer has no confidence field); a state near the request limit |

`lint --strict` fails on warnings as well.

## How the numbers are computed

- A noul answer counts as yes at or above `threshold`. Precision, recall and false positives are taken at that threshold. AUC is the probability that a `true` example scores above a `false` one, ties counting half, so it needs no threshold.
- The suggested threshold is the midpoint between two observed values that gives the highest recall while precision meets its target. When no threshold meets it, the suggestion is the one with the best balance of hits and false alarms.
- For choice and score the predicted answer is the most probable option or level after averaging the distributions over runs.
- Score also reports accuracy within one level and the mean distance between the returned score and the labelled level. A miss by one level and a miss by two are different problems, and plain accuracy hides which one you have.
- The JSON report carries the Brier score and a five-bin reliability table: does a probability of 0.8 come true about 80% of the time? Both need far more examples than a verdict does.

A failed request is never turned into an answer. The example is reported as not checked and left out of every metric; when a single answer in a response is missing or malformed, only that question loses the example. The command then exits with 2.

## Commands and options

```text
jev-calibrate init
jev-calibrate lint [--strict]
jev-calibrate check [--split tune|holdout|all] [--runs n] [--question id]... [--require gate|gate-above-confidence|ranker] [--json]
jev-calibrate compare [before.json after.json] [--split tune]

--dir <path>         project directory, default the current one
--provider <name>    typesafe or openrouter
--model <id>         model id to request
--base-url <url>     a server with the same API, used with the typesafe provider
--concurrency <n>    parallel requests, default 8
```

Exit codes: 0 done; 1 lint errors, a verdict below `--require`, or a regression in `compare`; 2 some examples could not be checked, or the command failed. In CI, `jev-calibrate check --split tune --require gate` fails the build when a question stops being a gate, for instance after a model upgrade. `gate-above-confidence` ranks below `gate`, since part of its answers go to review; require it by name when that is the behaviour you ship.

Model versions are pinned by default (`jev-1.13.0` on TypeSafe, `typesafe/jev-1.13` on OpenRouter), because a threshold belongs to a build and an alias can move. The report prints the build that answered. After a change of model, provider or question wording, run the check again; results do not carry over.

## Keys and data

Keys are read from the environment and sent only in the `Authorization` header. They are not printed and not written to disk. Example states are sent to the provider you chose, so label data you are allowed to send there. Run files hold ids, hashes and answers, never the example text.

`--base-url` and `TYPESAFE_BASE_URL` send both the states and the key to the host you name. They are read from your command line and your environment only, never from the project files, and a plain `http://` address other than this machine gets a warning in the report.

A project directory is treated as data from someone else: `state_file` cannot leave the directory, symlinks included; ids and option names that would reach `Object.prototype` are rejected; control characters are stripped from everything printed. Before the first request `check` prints how many requests it is about to make.

## As a library

```ts
import { check, lintProject, loadProject, renderReport } from 'jev-calibrate';

const { project, issues } = loadProject('./calibration');
const problems = [...issues, ...lintProject(project)];
const { report } = await check(project, { split: 'tune', runs: 3, persist: false });
console.log(renderReport(report));
```

`check` accepts `fetchImpl`, which makes it easy to test your own wrapper without the network. The metric functions (`auc`, `confusionAt`, `suggestThreshold`, `selectiveAt` and others) are exported as well.

## Limits

- Small sets give wide margins. Twenty correct answers out of twenty still leave room for a true precision of 0.86 (one-sided 95% bound), so twenty examples per class can tell you that a question is hopeless and cannot give you a figure to promise anyone.
- It measures one question at a time. Whether the pipeline around the question got faster or cheaper is counted per completed task, retries and review included, and that count is yours to make.
- Text only, as the API is.
- The split is by hash, so small sets need manual balancing with `split`.

## Development

Node 22.18 or later runs the TypeScript sources directly.

```sh
npm install --ignore-scripts
npm run typecheck
npm test
node src/cli.ts lint --dir examples/support-tickets
```

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE), copyright (c) 2026 SMKRV.
