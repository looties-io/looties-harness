---
name: lstack-workflow
description: "Use for an approved long-running or unattended development mission, resuming interrupted work, or a cumulative hardening campaign. Routes existing quality/security skills and records execution evidence. Not needed for a trivial one-step edit."
license: MIT
metadata:
  author: Looties
  version: "2.0.0"
---

# L-stack Workflow

Read `docs/lstack-v2.md` and the repository's canonical harness standard. This procedure coordinates existing skills and orchestration; it does not grant new authority or replace their rules.

## Start or resume

1. Identify the task, difficulty level, existing decisions and authorization. “I am going to bed; finish this” requests controlled autonomy for that task. Record the accepted scope, permitted actions, acceptance checks and exact grant reference. Ask only about a genuinely missing boundary; a previously approved plan remains approved.
2. Before unattended work, test prerequisites: repository/worktree, tools, dependencies, authentication availability without exposing credentials, CI access and isolated test infrastructure. Resolve authorized local failures now. Record a targeted blocker for anything requiring another actor; continue independent work. Do not send recurring “still blocked” messages without new information.
3. Reuse the existing Orca session/task graph and decision register. Create a mission receipt with `runtime/mission.mjs begin`, or `show` and `resume` an existing mission. Store orchestration references and available provider/Orca `sessionIds`, not a second task DAG. Append new session IDs through a checkpoint on handoff so the existing journal can link execution receipts. State lives outside `/tmp`, shared across worktrees of this clone.
4. Select only applicable installed skills: `code-cleanup` for changed code; `impossible-by-design` for recurrence; `harness-testing` for behavior across dependencies; `agentic-peer-review` for a cumulative cohort; `security-hardening` for security validation. Inspect the existing skill catalog before adding one. Missing required content is a setup failure, not successful application.
5. Deliver each selected skill with `mission.mjs skill`; read the complete returned content and its referenced instructions. After doing its work, record `applied` with the delivered hash and observable application. Verify through a meaningful real command using `verify --skill PATH`. Do not use `true`, echo, file-presence tests or assertions copied from the implementation as proof of a behavioral contract.

## Work to completion

- Map the blast radius and canonical implementation before editing. Use the existing owner, avoid duplicate mechanisms and speculative layers, and expose errors instead of hiding them behind fallbacks.
- Preserve the actual failing example for a confirmed bug, fix it, and run the relevant behavioral check. If two fixes rely on the same premise and fail the same check, test the premise before another patch.
- Record checkpoints after material progress and before context loss. Keep remaining work, decision references and affected blockers. Supersede decisions explicitly through the existing register; never silently rewrite the mandate.
- Before an external write, record effect intent and whether replay is safe. Record confirmation with the external receipt. After a timeout or partial response, reconcile the real external state before retrying a non-idempotent effect. A saved chat is not proof an operation ran once.
- A failed tool call is not a completed task. Inspect persisted output, make the smallest authorized correction, and rerun the affected check. Do not weaken tests, bypass CI or accept an ambiguous worker response. Only delegate when permitted; delegate with a compact whole-mission context to a fresh session.
- A self-review is not independent review. Retain the repository's independent-review and Git gates; complete all authorized implementation and verification even when a separate merge or production action remains restricted.
- Before claiming completion, commit the reviewed scope under repository rules, run relevant verification at that clean revision, clear only resolved work and blockers, reconcile effects, and call `mission.mjs finish`. Any new commit or skill change invalidates stale verification. Report the actual completion boundary, including restricted external actions.

## Hardening campaign

Use `hardening.mjs show` to read the frozen cohort, then `claim` with the originating session reference. Read PR intent, reviews, reverts and decisions for the entire interval and inspect the integrated code and cross-repository contracts. Use the quality and security skills above.

Inventory and matrix precede execution. Run baseline tests at the frozen revision through a mission verification receipt. Freeze each domain's assessment evidence, then immediately fix authorized findings while other domains continue. Record each finding separately with its reproduction, owner and next action; a restricted remediation must not block independent corrections.

Use `assess` for both domains, `finding` for every failed or unvalidated control, and `complete` to advance assessed coverage. Open remediation debt survives that transition. Resolve findings only through a completed remediation mission naming the finding and carrying actual verification. Never report “hardening complete” from an inventory, dispatch receipt or assessment alone.

## Learning

Feed reproducible recurring incidents to the existing self-healing loop. Evaluate baseline and candidate with the same model, task, tools, revision and limits; keep held-out incident cases out of drafting. Separate preservation of safety from useful improvement. An empty suite, all-green baseline/candidate, lower cost alone or a referenced skill name proves no benefit. Proposed changes remain subject to existing admission and independent-review rules.
