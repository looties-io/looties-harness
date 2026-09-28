# Agent Harness Standard

This standard owns the rules every coding agent follows in a repository that installs the harness, whatever the tool: where the harness sources live, how a repository configures it, the difficulty levels, the independent review, production confirmations, the external action boundaries, the self-healing loop and the inventory of safety nets. `install.mjs` copies it to `docs/agent-harness.md`; the rule files, levels, roles and guard messages link to the section that owns each of their lines. The reasoning behind each rule is in [the design decisions](https://github.com/looties-io/looties-harness/blob/main/docs/design-decisions.md).

Words used below: **the maintainer** is the human who owns the repository and answers the agent's questions; **the integration branch** is where reviewed work lands (`dev` by default); **the release branch** deploys production (`main` by default).

## Sources and Adapters

Generic rules that serve every repository live in a user-level file, `~/.agents/AGENTS.md` (template in [`user-level/AGENTS.md`](https://github.com/looties-io/looties-harness/blob/main/user-level/AGENTS.md)). Everything specific to one repository lives in its `.agents/` folder, which is the single source for every agent tool:

| Path | Holds |
|---|---|
| `.agents/rules/base.md` | The short rule that is always on |
| `.agents/rules/<name>.md` | Path-scoped rules that only point to documents under `docs/` |
| `.agents/rules/learned/` | Rules admitted by the self-healing loop, gated by the maintainer |
| `.agents/levels/` | One file per difficulty level |
| `.agents/agents/` | Agent roles |
| `.agents/hooks/` | Hook scripts, one dispatcher per event |
| `.agents/instincts/` | Reviewed atomic lessons, loaded at session start |
| `.agents/evals/` | Replayable canary cases for the self-healing loop |
| `.agents/healing/` | The self-healing loop's scripts |
| `.agents/schemas/` | JSON Schemas for harness files |
| `.agents/manifest.json` | The map from each source to its per-tool target |
| `.agents/manifest.state.json` | Generated hashes for the drift check, never edited by hand |
| `.agents/harness.config.json` | The repository's configuration (see [Configuration](#configuration)) |
| `.agents/sync-adapters.mjs`, `.agents/check.mjs` | The generator and the layout check |

`.claude/` and `.codex/` are adapters generated from the manifest by `node .agents/sync-adapters.mjs`. Edit the source in `.agents/`, run the generator and commit both; never edit a generated adapter by hand. `node .agents/sync-adapters.mjs --check` fails on any drift; run it in your local gate and in CI. The one hand-maintained part is `permissions` in `.claude/settings.json`: the generator owns only its `hooks`, and the check fails when an allow rule covers a [production command](#production-confirmations) or an `ask` rule for one is missing. The generator validates the manifest before writing: a missing source, an unknown kind, a target outside its adapter folder or claimed by two entries stops it.

Codex reads `.codex/` from the main checkout even inside a linked worktree, so its hooks take effect once they are on the branch checked out there; trust them once in the Codex startup review, and again whenever `.codex/hooks.json` changes.

`rules/base.md`, the level files, the path-scoped rules and the roles summarize this standard. They repeat only imperative sentences and link back to the section that owns each one. When a summary and this standard disagree, this standard wins and the summary is corrected in the same change. Keep them small, because they are loaded on every turn: `base.md` within 25 lines and 2 KB, a level file within 20 lines, every other rule within 20 lines. `node .agents/check.mjs` reports a breach.

### Agent Roles

Each file in `.agents/agents/` declares a `name`, a one-line `description` and an `access` of `read-only` or `read-write`. The generator maps `access` to each tool's tool list or sandbox. The roles are `explorer`, `planner`, `implementer`, `reviewer`, `verifier` and `healer`, the read-only drafting run of the [self-healing loop](#self-healing-loop). Add one only when a recurring task needs a different access or output.

### Instincts

Each file in `.agents/instincts/` is one reviewed lesson: frontmatter with `name`, `description`, `owner` (the document it was promoted from), `evidence` and `reviewAfter`, then imperative steps. The anchor hook loads every listed instinct at session start, resume and compaction, never on ordinary prompts.

### Manifest Format

`.agents/manifest.json` follows `.agents/schemas/manifest.schema.json`. Each entry has a unique kebab-case `id`, a `kind` (`rule`, `level`, `agent`, `hook`, `instinct`, `skill`), a `source` under `.agents/`, and `targets` with one key per tool: the generated path, or `null` with a `note` saying how that tool gets the content instead. For a hook, `options` is `{ "claude": [HookSpec], "codex": [HookSpec] }`, where a `HookSpec` is `{ "event", "matcher"?, "timeout"? }`. Every Markdown file under `.agents/rules/`, `.agents/levels/` and `.agents/agents/` has an entry.

## Configuration

`.agents/harness.config.json` is the one file a repository edits to adapt the harness. Every key is optional; `install.mjs` creates it from `harness.config.example.json`.

| Key | Default | Meaning |
|---|---|---|
| `branches.integration` | `dev` | Where reviewed L0 merges and direct pushes land |
| `branches.release` | `main` | The production branch: no agent pushes to it, and a merge into it is a production confirmation |
| `ci.workflow` | `ci.yml` | The workflow a direct push must have run green through `workflow_dispatch` |
| `productionCommands` | `[]` | `{ "command", "effect" }` entries that ask every time, at every level |
| `protectedConfig` | lint, test, Vite, TypeScript configs | Path patterns whose edit asks the maintainer |
| `docsCheck` | `null` | The command a documentation-only push runs instead of CI |
| `recordsDirectory` | `docs/records` | Where the self-healing loop writes its dated decision records |
| `journalRepository` | `null` | The private `owner/name` repository the agent journal syncs to |
| `signalLabels` | `[]` | Labels of issues your robots open, counted as failure signals |
| `neverTouch` | `[]` | Paths the self-healing loop never touches, on top of its own list |

A production command matches on words: the first word is the program, every later word must follow in order, and a word starting with `-` may appear anywhere on the command line. The config file is a harness file: the guard asks before any edit of it, because a looser config is a weaker guard.

## Difficulty Levels

Every task runs at a level. The agent announces it at the start with its reason, for example `Level L1: copy fix in one component`. The maintainer can raise the level at any time. Within a session the level never goes back down, for the agent or for the maintainer, because the guard reads the highest level of the session; a lower level starts a new session. When the work reaches an L2 trigger mid-task, the agent raises to L2 and stops to frame the rest.

**L2 is forced** when the task touches authentication, sessions, roles or permissions; money; database migrations or access rules; deletion of user data or remote resources; a production operation; or a wide change: several features at once, or shared infrastructure (CI workflows, git or agent hooks, agent settings, lint and test configuration, package scripts, the harness itself).

| | L0 | L1 | L2 |
|---|---|---|---|
| Before acting | Announce the level | Restate what was understood in one line opening with `Understood:` | Restate in one line opening with `Understood:`, ask 0 to 3 blocking questions with a default each, state assumptions and a plan, then wait |
| Commit, push a feature branch, open a draft pull request, mark it ready | Yes | Yes | Yes, once the maintainer approved the plan |
| Merge a pull request into the integration branch | Only the exact head commit an [independent review](#independent-review) approved, once checks are green | Never | Never |
| Push directly to the integration branch | Only under [Direct Push to the Integration Branch](#direct-push-to-the-integration-branch) | Never | Never |
| Push directly to the release branch | Never | Never | Never |
| Arm auto-merge | Only when the maintainer's opening instruction grants it | Never | Never |
| Run a [production command](#production-confirmations) | After the maintainer confirms it | After the maintainer confirms it | After the maintainer confirms it |

The L2 framing is the Contractor framing of the user-level rules. `Compris :` is accepted as a synonym of `Understood:`.

## Independent Review

At L0, an agent merges a pull request into the integration branch, or pushes directly to it, only after an independent reviewer approved the exact head commit:

- The reviewer runs in a fresh session started from a compacted summary of the author's conversation, never from its raw history and never by resuming an existing agent. The summary describes the work without arguing for it.
- The reviewer reads the diff, checks that the verification was proportionate and actually ran, and returns `APPROVE` or `REQUEST_CHANGES` with findings. A fix after a `REQUEST_CHANGES` gets a new review of the fix diff.
- Its final message ends with `Independent review: APPROVE <sha>` or `Independent review: REQUEST_CHANGES <sha>`, with the full 40-character commit. When the `reviewer` subagent finishes, the review-stamp hook (Claude `SubagentStop`) records that verdict in the worktree's git directory, under `agent-review-stamps/`, never committed, with the id of the session that spawned the reviewer. The latest verdict for a commit wins.
- For a pull request, the reviewer also posts the verdict line as the first line of a pull request comment.

The guard lets `gh pr merge` into the integration branch run without asking only when all of these hold; otherwise it asks, or blocks with a handoff where the tool cannot ask:

- the session's level is L0 and was never raised;
- the latest verdict comment or review approves the pull request's current head commit;
- the approval store holds an `APPROVE` for that head from a `reviewer` subagent that this same session spawned in this worktree: a comment alone, a review from another session or a review run by hand does not count;
- the pull request is not a draft and GitHub reports `mergeStateStatus` as `CLEAN`;
- the command carries `--match-head-commit <sha>`, never `--admin`.

Auto-merge (`--auto`) passes only when the first user message of the session grants it with a line of its own reading exactly `auto-merge allowed` (or `auto-merge ok`), outside any pasted text, at L0, with every condition above except green checks: the pinned commit makes GitHub wait for the required CI. Only a `reviewer` subagent may publish an approval comment. Every agent acts with the maintainer's GitHub identity, so these checks are a tripwire against mistakes, not proof of who reviewed.

### Direct Push to the Integration Branch

A direct push to the integration branch passes the guard only at L0, and only when all of these hold for the exact commit pushed:

- an independent reviewer of this session approved that commit, recorded by the review-stamp hook;
- a `workflow_dispatch` run of the configured CI workflow on a feature branch at that commit concluded successfully (`gh workflow run <workflow> --ref <feature-branch>`);
- the push fast-forwards the integration branch and names the commit literally: `git push origin <sha>:refs/heads/<integration>`.

A commit range that touches documentation only (`docs/**` and Markdown, except harness Markdown: `AGENTS.md`, `CLAUDE.md`, `.agents/` other than learned rules, `.claude/`, `.codex/`, `.github/`) needs no CI run when no code or check reads those files: the pushed commit must be checked out on a clean tree, and the configured `docsCheck`, if any, must report no finding on a pushed file. Otherwise the guard denies the push with a handoff, and a failed lookup denies too.

The guard denies an agent any write, move or deletion in the approval store, including running the code that writes it. Codex has no `SubagentStop` event, so it records no approval: its direct pushes and L0 merges are denied with a handoff. A push with no explicit destination after a branch switch on the same line is denied; changing where pushes land (`remote.*.push`, `push.default`, `branch.*.merge`) is denied; writes to branches through `gh api` ask. No agent pushes directly to the release branch, at any level, nor with `--all`, `--mirror` or a wildcard refspec.

## Production Confirmations

The commands listed in `productionCommands` ask the maintainer every time, at every level, and so does merging a pull request into the release branch. An approval covers one command, never the next one. The agent prepares the exact command, states its effect, and runs it once approved. Claude Code asks through the guard hook, even in bypass mode. Codex hooks cannot ask, so the guard blocks these commands there and the agent hands the exact command to the maintainer. `.claude/settings.json` also lists each production command as an `ask` rule, as a second layer, and the drift check fails when one is missing or an allow rule covers one.

## Mockup Rule

A change that alters what a person sees or interacts with, copy included, needs a mockup or artifact built from the current screen and validated by the maintainer before any code is written, at every level and on every surface. Invisible refactors, tests and logic without a visible effect are exempt. No hook enforces it: it is an instruction, and the review is the net.

## External Action Boundaries

**Allowed within the current level:** reading the repository, local commands, commits on a feature branch, draft pull requests.

**Ask first, every time:** production commands; sending content outside the repository (email, chat, posts, comments elsewhere, public artifacts); spending money or changing a paid plan; deleting or reconfiguring a remote resource; changing repository settings, rulesets, secrets or app permissions.

**Never:**

- `git commit --no-verify` or any other hook bypass, including `core.hooksPath` changes;
- `git add -A`, `git add .`, `git add -u` or `git commit -a`: stage explicit paths, because concurrent sessions share one index;
- force-pushing or deleting the integration or release branch, pushing directly to the release branch, pushing directly to the integration branch outside the conditions above, or merging with `--admin`;
- printing, reading or sourcing `.env*` files; a key a single command needs goes into that command's environment only;
- editing lint, test or build configuration to make a check pass. The guard asks before each edit of a `protectedConfig` path; restoring such a file is not guarded;
- removing or weakening the harness's own enforcement. The guard asks before any edit, write, removal, move, mode change, `git rm`, `git mv`, `git checkout` or `git restore` of `.agents/hooks/**`, `.agents/manifest*.json`, `.agents/harness.config.json`, the `reviewer` and `healer` roles and their generated copies, `.agents/evals/**`, `.agents/rules/learned/**`, `.agents/healing/**`, the generator and the check, `.claude/settings*.json`, `.codex/hooks.json`, `.codex/config.toml` and the git hook files, through the editor tools and the shell alike, inline `node -e` and `python3 -c` writes included. Unlike protected configuration, a restore asks too, because it can bring back an older, weaker guard. Running the generator is not guarded; its output shows in the diff.

## Self-Healing Loop

The loop turns what went wrong into tighter rules, better skills or, exceptionally, a proposal to relax a protection, and the maintainer decides each one. It only ever tightens on its own: nothing it drafts reaches an agent before the maintainer accepts it.

**Evidence.** Hooks write to the agent journal, outside the repository: `$HARNESS_JOURNAL_DIR`, or `$XDG_STATE_HOME/agent-journal` (default `~/.local/state/agent-journal`). `.agents/healing/journal-sync.mjs` pushes it to the private `journalRepository` when one is configured, so the evidence survives the loss of a machine. Secrets are redacted before any write. The guard records each ask and deny; the healing hook records the interpretation ledger and a summary of each session. Agents read the journal and never write it: the guard denies it. The loop's own runs record nothing (`HARNESS_CANARY`, `HARNESS_HEALING` or `HARNESS_NIGHTLY` set to `1`), and only the loop's scripts may set those variables: the guard refuses any shell command that sets one.

**Interpretation ledger.** At L1 and L2 the restatement opens with `Understood: <one sentence>`. The user's first reply to it is classified as validated, corrected, rejected or unclear. `node .agents/healing/ledger.mjs report` gives the first-time validation rate per week, level and tool. Three corrected or rejected restatements within 30 days become a failure event.

**Detection.** `node .agents/healing/nightly.mjs` runs locally, for example at 03:00 through launchd (`.agents/healing/install-nightly.sh`), from a dedicated worktree reset to the integration branch, on your own Claude subscription; it spends no CI minutes. It records as failure events: red CI runs, reverts on the integration branch, open issues carrying a `signalLabels` label, sessions that ended with a pre-commit failure or a guard denial, a user correction only when such an artifact corroborates it, interpretation gaps, and a protection that blocked three times within 30 days (production confirmations never count).

**Candidates.** The read-only `healer` role drafts at most three candidates a night, with the Read, Grep and Glob tools only; the guard refuses any other call in a healing run, shell included. A candidate is a rule (at most 5 lines and 400 bytes), a skill change or new skill, or a loosening, which is only a proposal and is implemented as a normal L2 change once accepted. The lint rejects before anything else: a text that loosens a safeguard, a text that tells an agent to change a path the loop never touches, a duplicate of an existing rule, and an oversized rule.

**Canaries.** A rule candidate replays the canary cases of `.agents/evals/` before the maintainer sees it. Each case runs Claude Code headless in a fresh worktree with pushes and GitHub made unreachable, and its `check.mjs` judges the result. A case that fails runs again with the candidate and once without it: the candidate is rejected when it fails twice and the baseline passes; anything else is inconclusive and blocks it. The harness ships two generic cases and a `_template`; add the ones that protect what matters in your project.

**The maintainer decides on issues.** Each surviving candidate becomes a GitHub issue labelled `self-healing` and `needs-human`. Closing it as completed accepts it; closing it as not planned rejects it, and a last comment records why. An issue that code closed (a merged pull request saying `Fixes #N`) is not a decision: the pass reopens it. The guard asks before an agent closes, reopens, edits, deletes or transfers such an issue.

**Admission.** The next nightly pass applies the decisions. What the maintainer read on the issue is exactly what is applied: the pass rebuilds the issue from the journal and applies the decision only when title and body match the closed issue character for character. Candidate fields refuse the characters GitHub can render as nothing (HTML, links, images, entities). An accepted rule becomes a file in `.agents/rules/learned/` with its issue, evidence, admission date and a review date at most 90 days later; every admission, rejection, retirement or renewal gets a line in a dated record under `recordsDirectory`. A headless L0 session has a `reviewer` subagent approve that commit and pushes it as a documentation-only change. An accepted skill change or loosening becomes a work issue instead; the pass marks each one and retries on the next run until the issue exists and its URL is saved. At most 40 rules are active, sharing a 6 KB budget; a rule past its review date gets a retire-or-keep issue, and a rule that held a whole period is a candidate to become a lint, test or hook.

## Safety Nets

No single net is trusted. Each one catches what the others miss:

| Net | Catches | Where |
|---|---|---|
| Instructions | Misrouted work, wrong level, forgotten rules | `AGENTS.md`, `.agents/rules/`, `.agents/levels/` |
| Anchor hook | Drift after long sessions and compaction: the full base rule, level, request and instincts at session start, resume and compaction; a digest of at most 1.2 KB on every other prompt | `.agents/hooks/anchor.mjs` |
| Guard hook | Hook bypass, `git add -A`, force push, pushes to the release branch, unreviewed pushes to the integration branch, writes to the approval store and the journal, `.env*` reads, self-approval; asks before production commands, protected configuration edits, harness edits and merges that fail the L0 conditions. When the guard itself fails, a `git` or `gh` command asks. A best-effort tripwire, not a sandbox | `.agents/hooks/guard.mjs` |
| Review-stamp hook | An L0 merge or direct push that no reviewer of the same session approved | `.agents/hooks/review-stamp.mjs` |
| Stop hook | Type errors left at the end of a turn, when the repository has a `typecheck` script | `.agents/hooks/stop-typecheck.sh` |
| Adapter drift check | A generated adapter that no longer matches its source, an allow rule covering a production command | `node .agents/sync-adapters.mjs --check` |
| Your pre-commit hook and CI | Lint, types and tests on every commit and on the merged head | Your repository |
| Independent review | What the author cannot see in their own work | [Independent Review](#independent-review) |
| Self-healing loop | Repeated failures turned into rules the maintainer decides on, replayed against canaries first | [Self-Healing Loop](#self-healing-loop) |
