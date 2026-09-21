# Contributing

## Running the checks

Node 22.18 or later runs the TypeScript sources directly, so nothing is built before testing.

```sh
npm install --ignore-scripts
npm run typecheck
npm run test:coverage
node src/cli.ts lint --dir examples/support-tickets --strict
```

The tests stub `fetch` or talk to a stub server on 127.0.0.1, so nothing leaves the machine and no API key is needed. `test:coverage` fails below 97% of lines, 84% of branches or 93% of functions in `src/`.

CI runs the same on Node 22.18 and 24, then builds the package and runs the built CLI on Node 20, the floor in `engines`. Two more jobs scan the code with Semgrep and, once the repository is public, review the dependencies a pull request changes. CI uses no secrets.

## Pull requests

- One change per pull request, branched from `main`.
- `main` takes squash and rebase merges only, so its history stays linear. A merge needs a green `checks` status and resolved review threads. The ruleset is kept in `.github/rulesets/main.json`.
- A behaviour change comes with a test. A bug fix comes with a test that fails on the old code.
- No runtime dependencies. A new development dependency needs its reason in the pull request.
- Actions in workflows are pinned by full commit SHA; a repository setting refuses a tag or a branch there. Dependabot keeps the pins current.
- Report a vulnerability the way [SECURITY.md](SECURITY.md) describes. Issues and pull requests are public.

## Versions

The version is `0.1.N`, where N is the number of commits on `main` up to and including the release commit. For a release:

```sh
n=$(( $(git rev-list --count HEAD) + 1 ))
npm version "0.1.$n" --no-git-tag-version
```

Set `VERSION` in `src/check.ts` to the same value; a test compares it with `package.json` and the lockfile. Commit as `jev-calibrate 0.1.$n`, push it, then tag that commit `v0.1.$n` and push the tag.

The tag starts `.github/workflows/release.yml`. It refuses a tag that disagrees with `package.json` or with the commit count, or that is not on `main`. One job runs the checks and packs the tarball; it holds no right to publish, because it executes code from the development dependencies. The second job publishes that tarball to npm through trusted publishing (no token is stored anywhere), and the third opens a GitHub release with generated notes. Rerunning the workflow is safe: a version already on the registry is not published again.

Only the repository admin can create a `v*` tag, and nobody can move or delete one: `.github/rulesets/release-tag-creation.json` and `release-tags.json`.

## Style

Prose in the repository (README, comments, commit messages) uses the plain hyphen-minus, no emoji and no filler phrases. Code follows the code around it.
