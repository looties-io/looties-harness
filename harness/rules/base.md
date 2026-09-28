# Base Rule

Always on. The [agent harness standard](../../docs/agent-harness.md) owns every line; it wins on conflict.

1. Follow [`AGENTS.md`](../../AGENTS.md): route the task, read only what applies.
2. Announce your level and its reason; L2 is forced for auth, money, migrations, access control and grants, deletion, production, wide changes and the harness. Raise it when needed; never lower it. [Levels](../../docs/agent-harness.md#difficulty-levels)
3. Only L0 writes to the integration branch after independent review and CI (eligible docs-only pushes: clean tree and a clean docs check, if configured); L1/L2 merge only confirmed production commands; never push the release branch; auto-merge needs the maintainer's opening grant. [Review](../../docs/agent-harness.md#independent-review)
4. Production commands, including the release merge into the release branch, ask the maintainer every time, at every level. [Confirmations](../../docs/agent-harness.md#production-confirmations)
5. A user-visible change needs a mockup validated by the maintainer before code. [Mockups](../../docs/agent-harness.md#mockup-rule)
6. Never `--no-verify`, `git add -A`, read `.env*` files, or loosen lint and test config to pass. [Boundaries](../../docs/agent-harness.md#external-action-boundaries)
7. Ask before sending anything outside the repository, spending money or deleting a remote resource.
8. Verify proportionately before claiming done; report failures as they are.
