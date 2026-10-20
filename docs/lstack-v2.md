# L-stack V2 execution policy

The original L-stack stays small: one canonical instruction source, proportional levels, independent review, explicit production authority, generated adapters and an evidence-based healing loop. V2 adds execution receipts and cumulative hardening without a new agent runtime, task scheduler or decision database. Repository-specific rules and explicit user authorization remain authoritative.

## Routing and actual use

`AGENTS.md` routes development to applicable `.agents/skills/*/SKILL.md` files. Read complete skill instructions before intervention; installation or a tool-call reference is not evidence of application. Ordinary small changes use the existing quality skills without durable ceremony. Long missions, explicit unattended requests and cumulative hardening load `lstack-workflow`.

The receipt stages are requested (mission `requiredSkills`), delivered (full content returned with SHA-256), applied (observable work reference), and verified (a real command executed successfully at the clean current revision). They establish delivery and recorded execution, not cognition or semantic correctness. A reviewer still judges whether the command proves the requirement. The private store is operational evidence, not a tamper-proof security boundary against its owner.

Claude and Codex retain their existing generated hooks. Codex hook trust must be reviewed through the tool's normal trust flow. GLM or another agent uses the same canonical files and explicit Node commands; native hook parity is not claimed. Existing review-stamp limitations and merge rules remain in force. Appliance runtime agents are a separate integration boundary; this change installs no Pi, OpenClaw or Hermes replacement.

## Durable missions and controlled autonomy

Natural-language unattended requests select the workflow, not unlimited permissions. Record the task's existing grant; preflight tools, access and test infrastructure before the user leaves. Continue authorized engineering through CI/infrastructure failures and targeted corrections. A newly restricted action blocks only dependent work. A completed audit baseline is the start of authorized remediation, not a reason to await a second blanket approval.

The store is `$XDG_STATE_HOME/lstack/<git-common-dir-hash>` or `~/.local/state/lstack/...`. Writes use revision checks, exclusive locks, file/directory fsync and atomic rename. Worktrees in one clone share it; separate clones need an explicit handoff. No TTL steals an active lock. After a crash, inspect the lock's owner, running sessions and committed JSON before manually removing exactly the abandoned lock. Back up this private state with existing local state backups. No raw transcript or secret is required.

Keep orchestration/session IDs and decision-register references. `checkpoint` appends decision references with explicit `supersedes`, retains targeted blockers and cannot amend the authorization. Use a new mission for a new mandate. `resume` reports unresolved effects and current HEAD; it executes nothing. Non-idempotent or ambiguous effects require reconciliation with the external system. The existing Orca/agent-route resume mechanism remains the continuation owner.

Example (all commands run from the installed repository; `--revision` is the latest returned revision):

```sh
node .agents/runtime/mission.mjs begin --file /private/path/mission.json
node .agents/runtime/mission.mjs skill --id task-1 --revision 1 --skill .agents/skills/code-cleanup/SKILL.md
node .agents/runtime/mission.mjs applied --id task-1 --revision 2 --file /private/path/application.json
node .agents/runtime/mission.mjs verify --id task-1 --revision 3 --skill .agents/skills/code-cleanup/SKILL.md --argv '["npm","test"]'
node .agents/runtime/mission.mjs checkpoint --id task-1 --revision 4 --file /private/path/checkpoint.json
node .agents/runtime/mission.mjs finish --id task-1 --revision 5
```

`mission.json` contains `id`, `summary`, `acceptance` and `scope` string arrays, `authorization: {reference, actions: [...]}`, `skills: [repository-relative paths]`, optional `orchestration` references, and `sessionIds` listing the provider/Orca session IDs available to the coordinator. Append fresh session IDs through `checkpoint` on handoff. The existing session journal records linked receipt stages separately from tool-call skill references; absent linkage means unobserved, not unused. `application.json` contains `path`, the delivered `digest`, and `application`. A checkpoint contains `remaining`, optional `decisions: [{id, reference, supersedes?}]`, and `blockers: [{reason, owner, blocks: [...], nextAction}]`. Use `effect --file` with `{id, description, status: "prepared", replaySafe: false}` before an external write; confirm using the same ID, `status: "confirmed"` and `evidence` afterwards. Verification commands must be read-only with respect to external systems; the receipt runner is not a sandbox.

## Cumulative hardening

Trigger per repository at **seven distinct active coding days OR fifty merged code PRs**, whichever occurs first. Days use the repository timezone (Europe/Paris by default) and first-parent integration history. Tests, runtime/security configuration and harness instructions count; docs-only changes do not. This counts merged/integrated work, not unmerged local activity. Unknown file types count conservatively as code.

Initialize with an explicit historical starting commit, timestamp and previous assessment/bootstrap reference. Bootstrap must review the uncovered history, not declare today already audited. Collect all GitHub pages for the named integration branch and complete local Git history. Missing, capped or shallow history is an error, not zero activity. Fetch the integration branch before collection. History collection currently supports GitHub; other hosts must supply a reviewed collector before activation.

`precheck` reserves a frozen cohort before scheduling: one campaign per repository, with a stable ID, integrated revision, PR list, commit activity and threshold receipt. New work remains after its watermark for the next campaign. Duplicate invocations return an explicit existing-campaign status rather than launching again. The actual agent claims the campaign with its session ID. A reserved dispatch without a claim is ambiguous: inspect Orca's launch receipt before resuming or transferring ownership. Do not blindly relaunch. After confirming the previous session is stopped and reconciling its effects, use `recover --revision N --file JSON` with `{previousOwner: "SESSION"}` (or `null` for an unclaimed launch) and an `evidence` reference. The next precheck offers the same campaign once; its cohort, assessments and findings survive the handoff.

Review the cohort's intent, reviews, reverts, incidents, decision changes, final integrated behavior and cross-repository contracts. A PR-by-PR checklist alone is insufficient. Reuse `agentic-peer-review` and `security-hardening`. Preserve domain baselines, then start authorized corrections immediately. Inventory, dispatch and report generation do not reset counters.

Both assessments require nonempty coverage, immutable report hashes and an actual baseline command receipt at the frozen revision. Every failed/unvalidated control references a finding. `complete` advances **assessed coverage**, preserving every open remediation; it does not claim the repository is fixed. Finding resolution requires a completed remediation mission whose acceptance names the finding. Required approvals affect only named work. The review/merge authority still belongs to the existing harness.

```sh
node .agents/runtime/hardening.mjs init --file /private/path/baseline.json
node .agents/runtime/hardening.mjs scan --ref origin/dev
node .agents/runtime/hardening.mjs precheck --ref origin/dev
node .agents/runtime/hardening.mjs show
node .agents/runtime/hardening.mjs claim --revision 2 --owner ORCA_SESSION_ID
```

Baseline JSON: `{ "base": "FULL_SHA", "since": "ISO_TIMESTAMP", "reference": "existing audit or bootstrap record", "timezone": "Europe/Paris" }`. Assessment JSON: `{domain: "quality"|"security", head: "FROZEN_SHA", verificationMission: "ID", reports: [paths], coverage: [{control, result: "passed"|"failed"|"unvalidated", evidence, finding?}]}`. Use `assess --revision N --owner SESSION --file JSON` for each domain, `finding` for classified findings, and `complete` only after both. Findings use `{id, domain, kind: "confirmed"|"configuration"|"coverage"|"theoretical", evidence, nextAction}`. `resolve --id FINDING --mission REMEDIATION` binds closure to verification. Use `show` after every transition to obtain the revision.

The existing Orca automation owns scheduling. Run a bounded hourly precheck through `runtime/schedule.mjs --repo PATH --ref origin/<integration>` (fetch, require the reviewed runtime on the integration branch, then reserve due work); exit 0 means one new campaign, 3 means no launch, 2 means collection/state failure. Orca records nonzero prechecks as skipped: inspect their output to distinguish healthy inactivity from failure. The automation prompt loads the canonical workflow, claims the prepared campaign and carries both domains through authorized remediation. A prepared campaign is not proof the automation launched. Reconcile unavailable sessions from Orca's run history. Do not create a competing LaunchAgent or LLM polling loop.

## Evidence-driven improvement

Keep the existing healer and decision register. Baseline and candidate use identical tasks, revision, tools, model and limits. Protected cases measure safety; held-out incident cases (`purpose: "benefit", heldOut: true`, with an explicit `model` or the runner's configured canary model) measure improvement with repeated baseline/candidate runs. Empty suites are inconclusive; all-green runs demonstrate preservation, not benefit. Infrastructure failures cannot count as improvement. Candidate readiness requires both safety and demonstrated benefit; admission remains separately reviewed. Skill-change proposals become ordinary reviewed implementation work, with paired evaluation of the actual skill change before promotion; the rule canary runner does not silently pretend to apply skill proposals.

Use real recurring failure classes to choose the smallest structural fix: canonical owner, API/types, then static/behavioral checks. Re-run a historical counterexample and a legitimate neighbor. Do not generate more policy text when an existing structural check can remove the error path. Retire guidance that shows no useful result.

## Provenance and limits

- [Potato Stack](https://github.com/backnotprop/pstack): structural quality review, correction of recurring classes, premise testing and controlled unattended interaction. Its `unslop` concerns writing; code quality here comes from structural review and existing cleanup skills. `teach` explains concepts; skill improvement belongs to the evidence/reflection loop. No wholesale skill import.
- [Google Harness²](https://github.com/google-research/harness2): propose, evaluate and compose changes against outcomes. V2 adapts comparative evidence, not the full search infrastructure. Skill delivery receipts are our implementation choice, not a claim that the paper provides them.
- [Pi durable](https://earendil.com/posts/pi-durable/): durable checkpoints, resumability and careful replay of effects. V2 reuses these ideas with existing Orca orchestration; no exactly-once external-effect guarantee or new agent runtime.
- Existing L-stack, ECC, Compactor and project rules remain the foundation. One canonical owner per policy; repository decisions amend existing records.

The private 14-day activity audit motivating this work identified incomplete worker output, repeated premise-dependent fixes, lost temporary briefs, unavailable unattended prerequisites, verification limited to mocks, weak skill-use observability and assessment/remediation gaps. These observations justify targeted controls; they do not yet quantify a production improvement. Track actual recurrence, completed remediation, time blocked, skill verification and CI outcomes before claiming benefit.
