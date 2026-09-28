---
name: concurrent-session-commits
description: Before each commit, check the branch and the staged list; another session may share this checkout's index and HEAD.
owner: ../../docs/agent-harness.md#external-action-boundaries
evidence: repeated incidents where one session's commit swallowed another session's staged work, or stacked it on the other session's branch
reviewAfter: 2027-03-31
---

# Concurrent Session Commits

Two sessions in one checkout share one index and one HEAD, and the pre-commit hook keeps the index open for minutes.

1. When the reflog shows checkouts or commits that are not yours, open a worktree before the first edit.
2. Stage explicit paths one at a time, then read `git diff --cached --name-only` and unstage anything that is not yours.
3. Run `git rev-parse --abbrev-ref HEAD` right before `git commit`; the other session may have switched the branch.
4. After a push, compare `git rev-parse HEAD origin/<branch>` instead of trusting the push output.
5. Never leave an uncommitted migration in a shared checkout while its prerequisites are not live.
