# Contributing

Thanks for your interest in looties-harness. This guide explains how to propose a change.

## Layout

- `harness/` is the product: rules, levels, agents, hooks, skills, runtime, healing, evals, instincts and schemas. `install.mjs` copies it to the target repository's `.agents/`.
- `install.mjs` is the installer, with zero runtime dependencies.
- `docs/` holds the harness standard, the execution policy and the design decisions.
- `user-level/` provides an optional template for rules shared by every repository of a user.
- `tests/` holds the vitest suite.

## Proposing a change

1. Open an issue first for a change of behavior or structure, so it can be discussed before code is written.
2. Branch from `main` and keep the change focused: one intent per pull request.
3. Edit `harness/` rather than files generated in a target repository. Paths written inside `harness/` refer to the installed layout (`.agents/…`).
4. Add or adapt the tests that demonstrate the expected behavior.
5. Before opening the pull request:
   - `npm ci`, then `npm test`;
   - install into a scratch Git repository: `node install.mjs <repo>`, then `node .agents/check.mjs` and `node .agents/sync-adapters.mjs --check` inside it.
6. Describe in the pull request the problem addressed, the change and how you verified it.

## Conventions

- Zero runtime dependencies: Node 20+ standard library only.
- Always-loaded files stay within the caps checked by `harness/check.mjs`.
- A skill reuses the others instead of duplicating their method.

## License

By contributing, you agree that your contribution is published under the project's [MIT license](LICENSE).
