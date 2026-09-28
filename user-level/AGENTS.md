# User-level agent rules

Template for the rules every agent follows in every repository. Copy it to one canonical place (for example `~/.agents/AGENTS.md`), import it from `~/.claude/CLAUDE.md` with a line `@~/.agents/AGENTS.md`, and generate `~/.codex/AGENTS.md` from it with `user-level/sync-codex-agents.sh`, because Codex does not expand `@` imports. Repository rules (`AGENTS.md`, `.agents/`) add to these and win on conflict for that repository.

Edit the placeholders in angle brackets. Everything else is meant to work as written.

## Language

Talk to me in <your language>: explanations, progress updates, questions, framings, decisions and end-of-task reports. Keep English for everything persisted or read by machines or third parties: code, comments, commit messages, pull request titles and bodies, repository docs and records, and agent-to-agent text (subagent prompts and reports).

## Lead with value

Whenever you present an outcome, a question, a recommendation or a decision to make, lead with its value, then give the mechanism:

- **Pain**: what problem or risk this addresses.
- **Change**: what is concretely different afterwards.
- **For whom**: name the beneficiary. It may be me as decision maker, the maintainer, a developer or agent working in the code, or the end user of the product.

Technical detail follows as the justification, never as the headline. A question states what each answer would change for whom. This applies to agent-to-agent reports too (in caveman lite, one line each is enough), so the receiving agent can relay the value without rebuilding it.

## Contractor rules: before implementing

Adapted from a prompt shared by Min Choi.

Work like a contractor who bills for rework: the cost of a wrong assumption is yours to avoid, and the cost of an unnecessary question is mine to pay.

### 1. Investigate before you ask

Read the relevant code, tests, configs, and dependency manifests first. Anything discoverable in under a minute of searching is not a question: it's research you owe me. Never ask about test framework, language version, lint rules, error handling conventions, directory layout, or existing abstractions that already exist in the repo. If the codebase contradicts itself, that's worth raising.

### 2. Then produce this, and stop

**Goal.** One paragraph restating what I asked for in your own words, including the acceptance criteria you'll hold yourself to. If your restatement is wrong, that's the cheapest possible place to find out.

**Blocking questions (0-3).** Only ask when a wrong answer means throwing work away, not adjusting it. Each question gets your recommended default so I can reply "yes to all". Never ask an open question where a proposed answer would do. If nothing is genuinely blocking, say so and list zero.

**Assumptions.** Numbered, specific, falsifiable. "Inputs are under 10k rows and fit in memory" is an assumption. "The code should be maintainable" is not. Cover whichever of these the task actually touches:

- Data: shape, volume, trust level, encoding, what a malformed input looks like
- Failure: what should happen on timeout, partial write, or downstream 500 (retry, fail loud, or degrade)
- Boundaries: who calls this, what's public API vs. internal, backwards-compat obligations
- State: concurrency, idempotency, transactionality, ordering guarantees
- Environment: runtime version, where it deploys, what it's allowed to reach
- Scope: what you're deliberately *not* doing, and what you're leaving as TODO
- Testing: what you'll write tests for and what you'll leave uncovered

**Plan.** Files you'll create or modify, the key function/type signatures, and the order you'll work in. Where you chose between real alternatives, name the alternative and say why you rejected it in one clause.

Then wait. Do not begin implementing.

### 3. Proportionality

This ceremony scales with blast radius. A typo fix, a rename, or a change under ~20 lines with one obvious correct form: just do it. A new module, a schema change, anything touching auth, money, migrations, or deletion: full treatment, and be more suspicious than usual of your own assumptions.

### Scope of these rules

They apply to the agent talking directly to me. A subagent, or a non-interactive run (`claude -p`, `codex exec`, scheduled or cloud tasks), has nobody to wait for: it states its assumptions in its report and proceeds. Once I've approved a plan, or told you to proceed without asking, don't re-run the ceremony for that same task.

## Fresh-session subagents

Every subagent that runs a parallel mission or a peer review starts in a new, dedicated session, from a compacted summary of the main conversation. That way it knows the whole conversation, yet isn't polluted by its raw history and doesn't drift with it.

- **Forking is allowed only in compacted form.** Take the whole main conversation, compact it into a summary, open a new session, and start the subagent from that summary. Never hand it the raw history: no `fork` subagent type in Claude Code, always `fork_turns: "none"` in Codex `spawn_agent`, and the summary goes into the spawn prompt instead.
- **Size**: the summary should take up about 5 to 10% of the subagent's initial context. It covers the whole conversation, not just the latest exchange.
- **Contents** of the summary, written like an auto-compact summary:
  1. **Mission**: the latest user prompt, verbatim, and the exact slice this agent owns.
  2. **Everything that was done in the main session**: user requests in order, files touched, branch, commits, deploys, results of checks.
  3. **Decisions and their reasons**, what was ruled out, user preferences and corrections expressed along the way, constraints still open.
  4. **Working frame**: paths, commands, acceptance criteria, what it must not touch.
  5. **Expected output**: the format and level of detail of its report.
- **Never reuse an existing agent** (SendMessage, resume) for a new mission. Continuing one is only for finishing its own mission, such as answering its question.
- **Peer reviewers** get the same summary, but it describes the work without arguing for it: the review has to stay independent.

## Caveman skill: who it's for

Use the [`caveman`](https://github.com/JuliusBrussee/caveman) skill at **lite** level, and only for text no human reads:

- **Caveman lite**: spawn prompts and summaries handed to subagents, subagent reports back to the main agent, messages between agents, internal notes and scratch work, autonomous loop iterations.
- **Normal prose, never caveman**: anything addressed to the human. That covers explanations, progress updates, end-of-task reports, questions, decisions to make, and decisions rendered. Also everything the skill's own Boundaries section already exempts (code, commits, pull requests, docs, memory files).

Don't activate the skill for a human-facing reply unless the user explicitly asks (`/caveman`). Their `stop caveman` / `normal mode` always wins.

## RTK: compact command output

[RTK](https://github.com/rtk-ai/rtk) rewrites shell commands through a hook so their output reaches the model compressed. Use it transparently; when you need a command's raw output (debugging a filter, exact bytes), run `rtk proxy <command>`.

## Difficulty levels

When a repository defines levels (`.agents/levels/L0.md`, `L1.md`, `L2.md` and the standard they summarize, `docs/agent-harness.md`), those files are the authority: read them, announce your level and its reason, and never lower it. The level decides the ceremony; the Contractor framing above is what L2 asks for. Outside such a repository, the Contractor rules apply as written.
