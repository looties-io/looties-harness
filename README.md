# looties-harness

The agent harness we run to build [Looties](https://looties.io), the marketplace where developers and tech enthusiasts buy and sell conference swag, limited-edition merch and developer gear.

One developer, several coding agents, one production codebase. This is the part of our L-Stack that keeps those agents fast on small things, careful on risky things, and unable to quietly remove their own safety nets. It works with Claude Code and Codex, has zero runtime dependencies, and fits in one `.agents/` folder.

## What you get

| Piece | What it does for you |
|---|---|
| **Contractor rules** | The agent investigates before asking, then states its goal, 0 to 3 blocking questions with defaults, falsifiable assumptions and a plan, and waits. Wrong assumptions surface before the code, where they are cheapest. |
| **Difficulty levels L0 / L1 / L2** | Ceremony scales with blast radius. A typo ships at L0; auth, money, migrations, deletion and production are forced to L2. The level only rises within a session. |
| **Lead with value** | Every report, question and decision starts with the pain, the change and who benefits, then the mechanism. You decide from the first two lines. |
| **Compacted-summary subagents** | Subagents and reviewers start from a summary of the whole conversation (5 to 10% of their context), never from the raw history, so they know the context without inheriting its drift. |
| **Caveman lite + RTK** | Agent-to-agent text is compressed with [caveman](https://github.com/JuliusBrussee/caveman); shell output is compressed with [RTK](https://github.com/rtk-ai/rtk). Humans always get normal prose. |
| **Guard hook** | A PreToolUse tripwire for both tools: denies `--no-verify`, `git add -A`, force pushes, pushes to the release branch, `.env` reads and hook-path changes; asks before production commands, lint and test config edits, and any edit of the harness itself. |
| **Anchor hook** | Re-injects the base rule, the current level and the request after start, resume and compaction, and a digest of at most 1.2 KB on every other prompt, so rules survive long sessions. |
| **Review stamps** | An L0 agent merges or pushes only a commit that a reviewer subagent of the same session approved, pinned to that SHA. A later push invalidates the approval. |
| **Self-healing loop** | A nightly local pass turns repeated failures into candidate rules, replays them against canaries, and opens an issue. You accept or reject by closing it. It only tightens on its own. |
| **One source, generated adapters** | Edit `.agents/`; `.claude/` and `.codex/` are generated and checked for drift. |

## Install

Requirements: Node 20 or later, git, and the GitHub CLI (`gh`) for merges and the self-healing loop.

**1. The two tools the stack assumes.** They matter more than they look: RTK and caveman are what keep a long multi-agent session inside its context budget.

```bash
# RTK: compresses command output before it reaches the model
brew install rtk            # or: cargo install --git https://github.com/rtk-ai/rtk
rtk init -g                 # Claude Code
rtk init -g --codex         # Codex

# caveman: compressed agent-to-agent prose
npx skills add JuliusBrussee/caveman -g
```

**2. The user-level rules.** Copy [`user-level/AGENTS.md`](./user-level/AGENTS.md) to `~/.agents/AGENTS.md`, fill in the placeholders, add `@~/.agents/AGENTS.md` to `~/.claude/CLAUDE.md`, and generate the Codex copy:

```bash
sh user-level/sync-codex-agents.sh
```

**3. The repository harness.**

```bash
git clone https://github.com/looties-io/looties-harness.git
node looties-harness/install.mjs /path/to/your/repo
```

The installer copies `harness/` to `.agents/`, the standard to `docs/agent-harness.md`, creates `.agents/harness.config.json` from the example, and generates `.claude/` and `.codex/`. It never overwrites an existing config. Then:

- edit `.agents/harness.config.json`: your branch names, your CI workflow, your production commands (the example ones are placeholders);
- run `node .agents/sync-adapters.mjs --check`: it names every production command that still lacks its `ask` rule in `.claude/settings.json` (remove the placeholder ones by hand);
- add that `--check` to your local gate and your CI;
- open Codex once in the repository and trust its hooks;
- optionally, install the nightly self-healing pass: `bash .agents/healing/install-nightly.sh` (macOS launchd, one job per repository).

## Configuration

Everything repository-specific lives in one file. Every key is optional.

```json
{
  "branches": { "integration": "dev", "release": "main" },
  "ci": { "workflow": "ci.yml" },
  "productionCommands": [
    { "command": "terraform apply", "effect": "changes production infrastructure" },
    { "command": "npm publish", "effect": "publishes a package to the registry" }
  ],
  "docsCheck": null,
  "recordsDirectory": "docs/records",
  "journalRepository": null,
  "signalLabels": [],
  "neverTouch": []
}
```

The guard asks before any edit of this file: a looser config is a weaker guard. The full reference is in [the standard](./docs/agent-harness.md#configuration).

## How the pieces compose

```text
 user-level rules (~/.agents/AGENTS.md)        repository harness (.agents/)
 ├─ Contractor framing                         ├─ rules/base.md ──► anchor hook (every prompt)
 ├─ lead with value                            ├─ levels/L0..L2 ──► announced, only rises
 ├─ compacted-summary subagents ──┐            ├─ agents/ (roles) ──► reviewer ──► review stamp
 ├─ caveman lite (agent↔agent)    │            ├─ hooks/guard.mjs ──► deny / ask / pass
 └─ RTK (command output)          │            └─ healing/ ──► nightly ──► issue ──► you decide
                                  └──────────────► the reviewer starts from a neutral summary
```

A typical L0 change: the agent announces `Level L0: typo in the setup guide`, fixes it, commits explicit paths (the guard refuses `git add -A`), spawns a reviewer subagent from a compacted summary, and the review-stamp hook records `Independent review: APPROVE <sha>`. The agent then merges with `--match-head-commit <sha>`, and the guard checks that the approval is from this session, for this exact commit, with green checks.

A typical L2 change: the agent announces L2, investigates, restates in one `Understood:` line, asks at most three questions with defaults, lists assumptions and a plan, and waits. It never merges; you do.

When something goes wrong (a red CI run, a revert, a session that ended on a guard denial, or the same protection or misunderstanding coming back three times in a month), the nightly pass drafts a rule of at most 5 lines, replays the canaries with and without it, and opens an issue. Close it as completed and the next pass admits the exact text you read. Close it as not planned and it is gone.

## How it differs from ECC

[ECC](https://github.com/affaan-m/ECC) is the reference agent harness. As of v2.2.2, the version we audited in September 2026, it ships 68 agents, 292 skills, 94 command shims, hooks, memory, continuous learning and a security scanner, with adapters for Claude Code, Codex, Cursor, OpenCode, Gemini and more. We audited it folder by folder before building ours and took several ideas from it (credited below). The differences are deliberate:

| | ECC | looties-harness |
|---|---|---|
| Scope | A full operating system: plan, test, implement, review, verify, remember, improve, for any team and many tools | A thin enforcement layer for one or a few people on Claude Code and Codex |
| Size | Hundreds of agents, skills and commands; installer profiles, marketplace, hosted app | 6 roles, 3 levels, 1 base rule, 5 hooks, 1 config file |
| Always-on context | About 10K tokens per session in our measurement | Base rule under 2 KB; per-prompt anchor under 1.2 KB |
| Behaviour modes | `contexts/` (dev, research, review) chosen by the user | Levels L0, L1, L2 announced by the agent, forced to L2 by risk, never lowered in a session |
| Learning | Continuous learning v2: hook observation, a background observer, instinct scoring, evolution into skills | Nightly detection, candidates drafted by a read-only role, canary replay, admission only by a human closing an issue, 40-rule cap, 90-day review |
| Self-protection | Hooks such as `block-no-verify` and config protection | Those, plus: every edit, removal or restore of the harness's own files asks, and agents cannot set the loop's privileged variables |
| Merging | Review from a fresh context | Review stamps pinned to the SHA, same-session reviewer, `--match-head-commit`, no `--admin`, auto-merge only on an explicit opening grant |

ECC is the better choice if you want a broad toolbox for a team and many tools. This harness is the better choice if you want few moving parts that you can read in an afternoon, and hard tripwires around the handful of actions that hurt.

## Why it suits solo builders, AI builders and micro-teams

A full dev team has code owners, branch protection enforced against real distinct identities, a release manager, and people who read each other's pull requests. A solo builder with five agents has none of that: every agent acts with the same GitHub account, nobody reads most diffs, and the one human is the bottleneck for every decision.

- **The human decides only what needs a human.** Levels send typos straight through and stop on money, auth, migrations and production. Decisions arrive value-first, with defaults, so "yes to all" is a valid answer.
- **Tripwires replace the missing teammates.** The guard, the review stamps and the self-protection rules do the job that separate identities and a second reviewer would do on a team. The standard says plainly that they are tripwires, not barriers.
- **Everything runs locally, on your subscription.** The nightly loop spends no CI minutes, and the only service it needs is GitHub issues.
- **It fits in your head.** One config file, one standard, 25 written design decisions. A micro-team can adopt it in an afternoon and remove any piece it does not want.

A larger team with real code owners and distinct identities will get less from the guard and more from its own processes; the levels, the Contractor framing and the review discipline still transfer.

## Other implementations we studied

Before writing a line, five read-only agents audited, in parallel: our own previous setup, our user-level configuration, ECC theme by theme and then folder by folder, every skill we had installed (one keep, change or remove verdict each), and the self-healing paper below. We also run and credit the tools the stack depends on.

| Source | What we took | What we left |
|---|---|---|
| [ECC](https://github.com/affaan-m/ECC) v2.2.2 | Path-scoped rules, contexts (as levels), one hook source per event, `block-no-verify`, config protection, instincts, a manifest with hashes, agent roles, parallel review with an adversarial verifier | The installer and profiles, the marketplace, 94 command shims, the 292-skill catalog, confidence-scored continuous learning, per-turn observers |
| [Self-healing harness paper](https://arxiv.org/abs/2609.24130) | Detect, Notice, Heal, Validate; an external gate; protected replay cases; rules as context, not weights | Forward-trial auto-promotion, continuous per-turn mode, uncapped rule growth |
| [obra/superpowers](https://github.com/obra/superpowers) | TDD, root-cause debugging, verification before claims, subagent-driven development | Anything that duplicated or contradicted the Contractor framing and the levels |
| Min Choi's Contractor prompt | Investigate first, then goal, blocking questions with defaults, falsifiable assumptions and a plan, then wait | Nothing: it became the user-level default and the L2 ceremony |
| [caveman](https://github.com/JuliusBrussee/caveman), [RTK](https://github.com/rtk-ai/rtk) | Installed as is | Vendoring them: they update on their own |

## Implementation choices, and why

- **One dispatcher per hook event, in plain Node.** No framework, no build step, nothing to install at runtime: a hook that fails to start is a guard that does not run.
- **Ask, not deny, for legitimate but risky edits.** Lint and test config, the harness's own files and production commands ask; only bypasses and irreversible actions are denied. Codex hooks cannot ask, so there an ask becomes a deny with a handoff message.
- **Fail closed on the risky path, open elsewhere.** When the guard itself errors, commands that can reach git or GitHub ask; other commands pass, so a guard bug cannot stop all work.
- **Human gate on GitHub issues, not comments.** Closing an issue is one click, is logged, and cannot be confused with a pasted note. Issues that code closes (`Fixes #N`) are reopened, because that is not a decision.
- **Exact-match admission.** The rule admitted is byte for byte the text the maintainer read. Candidate fields refuse the characters GitHub renders as nothing.
- **No confidence scores.** ECC scores instincts; we gate them. At our scale one human reading three candidates a night is cheaper and more predictable than a threshold.

## Known limits

The guard is a tripwire against mistakes by cooperating agents, not a sandbox against a hostile one. An interpreter can still write anywhere, and every agent acts with your GitHub identity. Specific gaps we know about and have not closed yet:

- **Piped and archive writes.** `find .agents/hooks -print0 | xargs -0 rm`, `rsync … .claude/` and `tar xf … -C .agents` pass without asking.
- **Clustered target flags.** `cp -rt .claude src` passes; `-t` is only recognised as a standalone flag.
- **Conservative `find -delete`.** `find . -name .DS_Store -delete` from the repository root asks (and is denied under Codex), even when the pattern cannot match a harness file.
- **Missing guard script.** When the guard script is missing (for example in a worktree that predates the harness), the Codex hook exits 0 and Claude Code treats the failed hook as a non-blocking error. Either way a deleted guard fails open until the drift check runs.
- **Interrupted journal init.** If the first `journal-sync.mjs init` fails after creating `.git` (a transient network error while existing hook output is merged), later runs treat the directory as a clone and skip the merge; the next sync can then conflict with the remote history. Delete the journal's `.git` and run `init` again.
- **Duplicate work issues.** After an accepted skill change, the loop finds its follow-up issue through GitHub search. If saving the issue URL fails and search indexing lags, a duplicate issue is possible.

## Credits

- **Contractor rules**: adapted from a prompt shared by Min Choi ([@minchoi](https://x.com/minchoi/status/2083400558023438731)).
- **Self-healing loop**: designed after *Self-Healing Harness for Runtime Oversight of Agent Self-Modification*, Sina Tayebati, Divake Kumar, Nastaran Darabi, Ranganath Krishnan and Amit Ranjan Trivedi ([arXiv:2609.24130](https://arxiv.org/abs/2609.24130)). We kept its Detect, Notice, Heal, Validate cycle and its protected replay cases. We replaced forward-trial auto-promotion with a human gate, because the paper found that 55% of the rules its gate rejected fixed their own failure but broke a case that previously worked.
- **ECC** by Affaan Mustafa ([affaan-m/ECC](https://github.com/affaan-m/ECC), MIT): path-scoped rules, contexts turned into levels, one hook source with a dispatcher per event, `block-no-verify` and config protection, instincts, the manifest with generated hashes, agent roles, the parallel-review pattern.
- **caveman** by Julius Brussee ([JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)): the compressed register used between agents. Installed, not vendored.
- **RTK** ([rtk-ai/rtk](https://github.com/rtk-ai/rtk)): command-output compression. Installed, not vendored.
- **superpowers** by Jesse Vincent ([obra/superpowers](https://github.com/obra/superpowers), MIT): the TDD, debugging, verification and subagent skills we run alongside the harness, rewritten to defer to the Contractor framing and the levels. The pre-merge review part became `agentic-peer-review` in [looties-skills](https://github.com/looties-io/looties-skills).

## Repository layout

```
harness/                 -> copied to .agents/ by install.mjs
|-- rules/base.md        <- always on, under 2 KB
|-- levels/L0..L2.md
|-- agents/              <- explorer, planner, implementer, reviewer, verifier, healer
|-- hooks/               <- guard, anchor, review-stamp, healing, stop-typecheck
|-- healing/             <- the nightly self-healing loop
|-- evals/               <- canary cases (two generic ones and a template)
|-- instincts/
|-- schemas/
|-- manifest.json
|-- sync-adapters.mjs    <- generates .claude/ and .codex/, --check for drift
`-- harness.config.example.json
docs/agent-harness.md    <- the standard, copied into your repo
docs/design-decisions.md <- the 25 decisions and their reasons
user-level/              <- the user-level rules template and the Codex sync script
install.mjs
tests/                   <- vitest: guard, config, anchor, generator, check, stamps, self-healing, installer
```

Run the tests with `npm install && npm test`.

## Related

- [looties-skills](https://github.com/looties-io/looties-skills): the agent skills we use to build Looties, including `harness-testing` and `agentic-peer-review`.

## About Looties

Looties is the marketplace where developer culture meets resale. Browse rare conference merch, archived launch gear, and developer collectibles.

→ [looties.io](https://looties.io) · [GitHub org](https://github.com/looties-io) · [Discord](https://discord.gg/A6UcsyCHCb)

## License

MIT
