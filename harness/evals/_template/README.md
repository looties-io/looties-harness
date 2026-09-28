# Writing a project canary

A canary case is a small, realistic task that must keep working whatever rule the self-healing loop admits. Before a candidate rule reaches the maintainer, the loop runs every case twice: once with the candidate appended to the agent's system prompt and, when a case fails, again with and without it. A candidate is blamed only when a case fails twice with it and passes without it.

The harness ships two generic cases, `clean-commit` and `investigate-only`. Add your own for the behaviours your project cannot afford to lose, such as a migration that ships with its grants, a component that stays translated, or a service that still boots.

## Steps

1. Copy this directory to `.agents/evals/<case-id>/`. A directory whose name starts with `_` is never run, so the template itself stays inert.
2. In `case.json`, set `id` to the directory name, describe what the case `protects`, and write the `prompt` as the maintainer would ask. `{nonce}` is replaced by a random string, so a check can tell this run's output from a previous one's. Set `setup.linkNodeModules` to `true` when the task needs the dependencies (the worktree is fresh).
3. In `check.mjs`, assert the outcome from the worktree, the commands and the final answer. Start from `forbiddenCommandFailures(commands, PROJECT_FORBIDDEN)` and list there any command that deploys or reaches production in your project.
4. Run it once without a candidate: `node .agents/healing/canary.mjs run --case <case-id>`. A case that fails on the integration branch blocks every admission until it is fixed.

## Good cases

- One behaviour per case, checked on its outcome (files, commits, answer), not on the exact steps.
- No secret, no network and no production access: the runner cuts GitHub and git pushes, and your check rejects anything else that leaves the machine.
- Fast: a case runs up to three times per candidate. Keep the prompt small and `maxTurns` tight.

A skill's replay cases live under `.agents/evals/skills/<skill>/<case-id>/` and run when a candidate changes that skill.
