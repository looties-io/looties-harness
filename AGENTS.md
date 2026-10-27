# Agent instructions

This repository is looties-harness, an open-source package. `install.mjs` copies `harness/` into the `.agents/` directory of another repository. You are working on the product, not inside a harnessed repository: the rules, levels, agents and skills under `harness/` are content you edit, not instructions for this session.

## Where to change things

- Harness behavior: `harness/` only. It is installed as `.agents/`, so paths written inside it refer to the installed layout.
- Installation: `install.mjs`.
- The harness standard, execution policy and design decisions: `docs/`. The user-level rules template: `user-level/`.

## Conventions

- Zero runtime dependencies: Node 20+ standard library only. npm dependencies serve the tests.
- Keep always-loaded harness files within the caps enforced by `harness/check.mjs`.

## Before proposing a change

1. `npm test`.
2. Install into a scratch Git repository and check it: `node install.mjs <scratch>`, then `node .agents/check.mjs` and `node .agents/sync-adapters.mjs --check` inside it.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution process.
