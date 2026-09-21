# Security policy

## Supported versions

Fixes go into the latest release. Older versions have no maintenance branches.

## Reporting a vulnerability

Report it privately through [GitHub security advisories](https://github.com/smkrv/jev-calibrate/security/advisories/new). Do not open a public issue for it.

Include the version or commit, the command you ran, and a project directory (`questions.json`, `examples.jsonl`) that reproduces the problem. Before attaching anything, remove API keys and any states you are not allowed to share.

## Scope

`jev-calibrate` reads API keys from the environment and treats a project directory as data from someone else. The README section [Keys and data](README.md#keys-and-data) lists what it guarantees. A report is in scope when it breaks one of those guarantees:

- a key printed or written to disk
- `state_file` reading a file outside the project directory
- an id or option name that reaches `Object.prototype`
- control characters from a project file reaching the terminal
- a key or states sent to a host other than the provider or `--base-url` you chose

Problems in the TypeSafe or OpenRouter services go to their owners.
