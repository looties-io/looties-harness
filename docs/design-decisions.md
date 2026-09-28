# Design decisions

The harness was built in three waves on a production codebase run by one developer and several agents, then extracted here. These are the 25 decisions that shaped it, with the intent and the reasoning behind each. The numbers are stable: code comments and the [standard](./agent-harness.md) cite them as "design decision N".

Most of them are about one tension. Agents are fast and tireless, and one person cannot read everything they do. So the harness trades review effort for mechanical tripwires wherever a mistake is cheap to detect and expensive to undo, and keeps the human for the decisions only a human can take.

## Foundations

**1. One source, generated adapters.** Generic rules live in one user-level file and serve every repository; repository rules, hooks, roles, lessons and evals live in `.agents/`. `.claude/` and `.codex/` are generated from it and checked for drift. *Why:* hand-copied rule files drift within weeks, and one tool (Codex) does not expand `@` imports, so "just import it" silently fails there. A generator plus a drift check makes the copy impossible to forget.

**2. Difficulty levels.** Every task runs at L0, L1 or L2, announced with a reason. L0 acts, verifies and may merge after an independent review; L1 restates what it understood, then delivers; L2 restates, asks blocking questions with defaults, states assumptions and a plan, then waits. L2 is forced for auth, money, migrations, deletion, production and wide changes. Production commands ask every time, at every level. *Why:* the same ceremony for a typo and for a migration is either too heavy or too light. Letting the blast radius pick the ceremony keeps small work fast and risky work slow.

**3. Visible changes need a mockup first.** A change a user sees or interacts with, copy included, needs a mockup validated by the maintainer before code. *Why:* the most expensive rework in agent-built products is not a bug, it is a screen nobody wanted. A mockup costs minutes; a rebuilt feature costs hours.

**4. Curate skills, keep one copy.** Skills were audited one by one: duplicates removed, near-neighbours from the same source kept, one physical copy per skill with symlinks elsewhere. Imported skill families that competed with the harness's own rules were rewritten to defer to them. *Why:* every loaded skill description costs context on every turn, and two skills that disagree make the agent pick one at random.

**5. Every self-healing decision leaves a record.** Each admitted, rejected or retired learned rule produces a dated record saying what changed and why. *Why:* rules that appear without a trail are the ones nobody dares to remove later.

**6. Roll out by domain.** The harness was built in independent worktrees split by technical domain, all from one shared brief. *Why:* one giant change cannot be reviewed; domains with a shared contract can, in parallel.

## Communication

**7. Talk to the human in their language, persist in English.** Explanations and questions go to the maintainer in their language; code, commits, docs and agent-to-agent text stay in English. *Why:* the human reads faster in their language, and everything persisted is read by tools and strangers.

**13. Measure understanding.** At L1 and L2 the restatement carries a machine-readable `Understood:` line; the user's next reply is classified as validated, corrected or rejected, and the pair is stored outside the repository. Recurring gaps feed the self-healing loop. *Why:* "the agent misunderstood me" is the most common failure and the least measured one. A first-time validation rate turns it into a number.

**21. Lead with value.** Every outcome, question or recommendation starts with its value: the pain it addresses, what changes, and for whom. The mechanism follows. *Why:* a maintainer who reads twenty agent reports a day decides on the first two lines. If those lines are mechanism, the decision is made on the wrong information.

## Review and merging

**8. Autonomous L0 merge, with conditions.** An L0 agent merges only when a reviewer-role agent's approval comment names the head commit, the merge pins that commit with `--match-head-commit`, no newer change request exists, checks are green without `--admin`, and the level was never raised. Any error in the guard's lookup asks or denies. *Why:* pinning the reviewed commit is what makes the review mean something: a push after the review invalidates it automatically.

**9. Deny with handoff where a tool cannot ask.** Codex hooks can only deny, so a production command there is denied with a message that hands the exact command to the maintainer. *Why:* silently allowing what the other tool would have asked about is the worst outcome; a clear handoff costs one copy-paste.

**14. Reviews check the contract.** Every independent review compares the change with the design decisions and the standard, and reports drift as its own finding. *Why:* code can be correct and still quietly change a rule nobody agreed to change.

**16. The level only rises within a session.** The level in force is the highest one announced by the agent or set by the maintainer; lowering it takes a new session. *Why:* otherwise a pasted note that says "L0" could open the autonomous merge in the middle of a risky task.

**17. Direct push after review and green CI, never to the release branch.** A direct push to the integration branch passes only at L0, for a commit an independent reviewer approved (recorded by a hook, never by the pushing agent), that a manually dispatched CI run passed, and that fast-forwards the branch. No agent pushes to the release branch. *Why:* a pull request is ceremony, not safety; the safety is the review and the green checks on that exact commit. Every agent shares the maintainer's identity, so these are tripwires, not barriers, and the standard says so.

**19. The approval must come from this session's reviewer.** The approval that unlocks an L0 merge or push is one a hook recorded when a reviewer subagent spawned by the same session, in the same worktree, finished. A review from another session, another worktree or the other tool does not count. *Why:* a comment can be posted by anyone with the account; a hook-recorded verdict from a subagent this session started is much harder to fake by accident.

**22. Auto-merge only on an explicit opening grant.** An agent arms auto-merge only when the maintainer's first message grants it on a line of its own, and then only at L0, with the reviewed commit pinned. *Why:* auto-merge moves the last human checkpoint into the future. It should be a deliberate choice made before the work starts, not a convenience the agent reaches for at the end.

**24. Documentation-only pushes skip CI.** A push that touches documentation only needs the in-session review and a clean documentation check, but no dispatched CI run. Harness Markdown (`AGENTS.md`, `.agents/`, adapters, workflows) is not documentation here, because it drives agent behaviour. *Why:* CI minutes are budgeted, and a typo fix in a guide should not cost a full pipeline. Anything that changes behaviour keeps the full path.

## The guard protects itself

**10. Two anchor sizes.** The anchor hook injects the full base rule, level and request at session start, resume and after compaction, and a short digest (at most 1.2 KB) on every other prompt. Both are generated from the base rule. *Why:* rules fade after compaction and in long sessions, but re-injecting everything every turn costs more context than it saves.

**15. The adapters domain owns the manifest shape.** One domain may change the manifest format, and the schema and checker change with it. *Why:* a format edited from several places drifts.

**18. Protected configuration edits ask, they are not denied.** Lint, test, build and type configuration change often for legitimate reasons, so editing them asks the maintainer; restoring them is free. *Why:* "loosen the lint rule until it passes" is the classic agent shortcut, but a hard deny would block real work.

**20. The harness guards itself.** Edits, deletions, moves and restores of the guard's own files (hooks, manifest, config, generator, reviewer role, self-healing gate, tool settings, git hooks) ask the maintainer, through the editor and the shell alike. Running the generator is free because its output shows in the diff. *Why:* an agent must not be able to remove its own safety nets, even by accident, even while "fixing" a failing test.

## Knowledge and self-healing

**11. Knowledge stays documentation.** Lessons are promoted into current documents; a lesson becomes a gate (lint, hook, test) only when it has proven itself. *Why:* a gate written from one incident tends to block the next legitimate case.

**12. Instincts are small reviewed lessons.** `.agents/instincts/` holds atomic lessons (20 lines at most) loaded at session start. They record what to do, not how an agent interpreted an instruction. *Why:* a few sharp lessons survive in context; a long lessons file gets skimmed.

**23. Self-healing storage and gate.** Evidence lives in a journal outside the repository, so nothing pollutes the codebase; synced to a private repository, it survives the loss of a machine. The maintainer decides on GitHub issues, never in comments: closing as completed accepts, closing as not planned rejects. The loop runs locally on the maintainer's subscription, improves rules and skills, and only tightens on its own; it may propose loosening a protection that broke a feature or blocked legitimate work three times in 30 days, and such a proposal ships only as a normal reviewed change. *Why:* the research this loop is based on found that 55% of the self-proposed rules its gate rejected (211 of 383) fixed their own failure but broke something that worked. Locally good fixes are often globally bad. A human gate on a closed issue is cheap, auditable and hard to fake.

**25. No paid preview unless asked.** Work branches get no billed preview deployment unless the maintainer asks for one. *Why:* a solo builder pays for every preview; most branches never need one.
