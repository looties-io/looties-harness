#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOOP_ENV } from '../hooks/config.mjs';
import { journalRoot, readDocument, readRecords, writeDocument } from '../hooks/journal.mjs';
import { runCanaries, loadCases } from './canary.mjs';
import { buildCandidate, listCandidates, loadCandidate, saveCandidate, setStatus } from './candidate.mjs';
import { detect } from './detect.mjs';
import { candidateIssue, commentOnDecision, createIssue, ensureLabels, findWorkIssue, markApplied, openRetireReviews, pendingDecisions, reopenForMaintainer, retireIssue, workIssue } from './github.mjs';
import { syncJournal } from './journal-sync.mjs';
import { formatReport, ledgerReport } from './ledger.mjs';
import { LIMITS, addDays, gh, harnessConfig, isoDate, isoWeek, repoRoot, run } from './lib.mjs';
import { applyPlan, dueRules, planDecisions } from './review.mjs';

// The nightly self-healing pass (design decision 23), run by launchd at 03:00
// from a dedicated worktree reset to origin/<integration branch>
// (install-nightly.sh). Everything runs on this machine and on the
// maintainer's Claude subscription; GitHub is only used for the decision
// issues and the pushes the guard allows. Steps:
//   1. pull the agent journal; 2. detect failures; 3. open retire-or-keep
//   issues for learned rules past their review date; 4. apply the
//   maintainer's decisions in a fresh worktree and push them to the
//   integration branch as documentation (design decision 24) through a
//   Claude session whose reviewer approves them;
//   5. draft at most three candidates with the read-only healer; 6. replay the
//   canaries for rule candidates; 7. publish the survivors as needs-human
//   issues; 8. write the weekly digest; 9. push the journal.
// A step that fails is logged and the next one still runs.
// Owned by docs/agent-harness.md#self-healing-loop.

const LOCK_STALE_HOURS = 6;
const CLAUDE = process.env.HARNESS_CLAUDE_BIN || 'claude';
const integrationBranch = () => harnessConfig(repoRoot).branches.integration;

const log = (message) => console.log(`[nightly ${new Date().toISOString()}] ${message}`);

export function admissionPrompt(sha, files, integration = integrationBranch()) {
  // File names come from rule titles, so they stay out of the prompt: the
  // reviewer lists them itself.
  return [
    `Level L0: push the self-healing admission commit ${sha} to ${integration} as a documentation-only change (design decision 24). It only adds records and learned rules written from the issues the maintainer closed (${files.length} file${files.length === 1 ? '' : 's'}; git show --stat ${sha} lists them). Recording decisions the maintainer took is documentation work at this level; announce it and no other.`,
    '',
    `1. Spawn the reviewer subagent on origin/${integration}..${sha} in this worktree. Ask it to check that every learned rule is the exact text of the candidate issue the maintainer closed as completed, only tightens, and that the record lists each decision with its issue.`,
    `2. If it approves, run exactly: git push origin ${sha}:refs/heads/${integration}`,
    '3. If it requests changes or the guard denies the push, stop: do not fix, retry or work around anything. Print the findings.',
    'Do nothing else.',
  ].join('\n');
}

export function draftingPrompt(events, candidates) {
  return [
    'Self-healing drafting run. Follow your healer role. Failure events since the last run, as JSON:',
    '```json',
    JSON.stringify(events.map(({ at, key, source, summary, url, rule, count, samples, skills, precommitFailures, guardReasons, labels }) => ({ at, key, source, summary, url, rule, count, samples, skills, precommitFailures, guardReasons, labels })), null, 1),
    '```',
    'Open or recent candidates (do not propose them again):',
    ...(candidates.length > 0 ? candidates.map((candidate) => `- [${candidate.status}] ${candidate.type}: ${candidate.title}`) : ['- none']),
    `Return at most ${LIMITS.candidatesPerNight} candidates as one fenced json block holding an array; the pass lints and records them.`,
  ].join('\n');
}

/**
 * The candidates in the healer's final message: the last fenced json block
 * holding an array, cut to the nightly limit. Anything else yields none.
 */
export function healerCandidates(text, limit = LIMITS.candidatesPerNight) {
  const blocks = [...String(text).matchAll(/```json\s*\n([\s\S]*?)```/g)];
  for (const block of blocks.reverse()) {
    try {
      const parsed = JSON.parse(block[1]);
      if (Array.isArray(parsed)) return parsed.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)).slice(0, limit);
    } catch {
      // not the candidate block
    }
  }
  return [];
}

/** Candidates to publish tonight: canary-passed rules and lint-clean skill or loosening proposals, oldest first. */
export function publishable(candidates, limit = LIMITS.candidatesPerNight) {
  return candidates
    .filter((candidate) => (candidate.type === 'rule' ? candidate.status === 'ready' : candidate.status === 'drafted'))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, limit);
}

export function digestMarkdown({ week, events, candidates, ledgerRows }) {
  const bySource = new Map();
  for (const event of events) bySource.set(event.source, (bySource.get(event.source) ?? 0) + 1);
  const byStatus = new Map();
  for (const candidate of candidates) byStatus.set(candidate.status, (byStatus.get(candidate.status) ?? 0) + 1);
  return [
    `# Self-healing digest ${week}`,
    '',
    `Failure events (30 days): ${[...bySource].map(([source, count]) => `${source} ${count}`).join(', ') || 'none'}.`,
    `Candidates: ${[...byStatus].map(([status, count]) => `${status} ${count}`).join(', ') || 'none'}.`,
    '',
    '## Interpretation ledger',
    '',
    formatReport(ledgerRows),
    '',
  ].join('\n');
}

function claude(args, { cwd, env = {}, timeoutMinutes = 30 }) {
  const result = spawnSync(CLAUDE, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMinutes * 60_000, maxBuffer: 256 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function step(summary, name, action) {
  try {
    summary[name] = action() ?? 'done';
  } catch (error) {
    summary[name] = `failed: ${String(error?.message ?? error).split('\n')[0]}`;
  }
  log(`${name}: ${typeof summary[name] === 'string' ? summary[name] : JSON.stringify(summary[name])}`);
}

async function asyncStep(summary, name, action) {
  try {
    summary[name] = (await action()) ?? 'done';
  } catch (error) {
    summary[name] = `failed: ${String(error?.message ?? error).split('\n')[0]}`;
  }
  log(`${name}: ${typeof summary[name] === 'string' ? summary[name] : JSON.stringify(summary[name])}`);
}

function acquireLock() {
  const lock = path.join(journalRoot(), 'state', 'nightly.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_HOURS * 3600_000) rmSync(lock);
  closeSync(openSync(lock, 'wx'));
  writeFileSync(lock, String(process.pid));
  return () => rmSync(lock, { force: true });
}

// Rules whose retire-or-keep decision landed during this pass; the pass's
// own checkout still shows them as they were before.
const decidedTonight = new Set();

function admit() {
  const decisions = pendingDecisions();
  for (const decision of decisions.filter((entry) => entry.closedByCode)) reopenForMaintainer(decision.number);
  if (decisions.length === 0) return 'no decision to apply';
  const integration = integrationBranch();
  run('git', ['fetch', '--quiet', 'origin', integration]);
  const worktree = mkdtempSync(path.join(tmpdir(), 'harness-healing-admit-'));
  const branch = `healing/admit-${isoDate()}-${process.pid}`;
  run('git', ['worktree', 'add', '-q', '-b', branch, worktree, `origin/${integration}`]);
  try {
    // The pre-commit hook may need the dependencies; a repository without
    // node_modules commits without them.
    if (existsSync(path.join(repoRoot, 'node_modules'))) symlinkSync(realpathSync(path.join(repoRoot, 'node_modules')), path.join(worktree, 'node_modules'));
    const candidates = new Map(decisions.filter((decision) => decision.candidateId).map((decision) => [decision.candidateId, loadCandidate(decision.candidateId)]).filter(([, candidate]) => candidate));
    const plan = planDecisions(decisions, { root: worktree, candidates, date: isoDate(), retireIssues: readDocument('state/retire-issues.json') ?? {} });
    const files = applyPlan(plan, worktree);
    if (files.length === 0) return 'decisions produced no change';
    run('git', ['add', '--', ...files], { cwd: worktree });
    run('git', ['commit', '-q', '-m', `docs(self-healing): apply decisions of ${isoDate()}\n\nIssues: ${plan.applied.map((number) => `#${number}`).join(', ')}`], { cwd: worktree, timeout: 30 * 60_000 });
    const sha = run('git', ['rev-parse', 'HEAD'], { cwd: worktree }).trim();
    // The nightly variable confines the push to admission files and keeps the session out of the journal.
    const session = claude(['-p', admissionPrompt(sha, files, integration), '--permission-mode', 'bypassPermissions', '--max-turns', '30'], { cwd: worktree, env: { [LOOP_ENV.nightly]: '1' } });
    run('git', ['fetch', '--quiet', 'origin', integration]);
    const landed = spawnSync('git', ['merge-base', '--is-ancestor', sha, `origin/${integration}`], { cwd: repoRoot }).status === 0;
    // A blocked admission is a failure of the pass, not a quiet outcome.
    if (!landed) throw new Error(`admission ${sha.slice(0, 12)} not pushed: ${session.stdout.trim().split('\n').slice(-3).join(' ')}`);
    for (const name of plan.decidedRules) decidedTonight.add(name);
    // Tonight's drafting and canaries read the learned rules from this checkout.
    const checkout = advanceCheckout(sha);
    log(`admission: ${checkout}`);
    // The journal first: if labelling the issues fails part-way, a candidate
    // already marked applied is not admitted a second time.
    for (const [candidate, status, note] of plan.statusChanges) setStatus(candidate, status, note ? { note } : {});
    markApplied(plan.applied);
    for (const { number, text } of plan.notices) commentOnDecision(number, text);
    return { pushed: sha, applied: plan.applied, files };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot });
    spawnSync('git', ['branch', '-D', branch], { cwd: repoRoot });
  }
}

/**
 * Moves the pass's own checkout to the admitted commit, so the drafting run
 * and the canaries of the same night see the rules admitted tonight. Only a
 * detached, clean checkout that the commit fast-forwards moves: the dedicated
 * nightly worktree, never a checkout someone works in. And only when every
 * commit in between touches documentation and learned rules alone: code that
 * reached dev since the pass started would disagree with the code this
 * process already loaded, so the new rules then wait for the next night.
 */
export function advanceCheckout(sha, { cwd = repoRoot } = {}) {
  const git = (args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (git(['symbolic-ref', '-q', 'HEAD']).status === 0) return 'checkout on a branch, left as is';
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (status.status !== 0 || status.stdout.trim()) return 'checkout has local changes, left as is';
  if (git(['merge-base', '--is-ancestor', 'HEAD', sha]).status !== 0) return `${sha.slice(0, 12)} does not fast-forward the checkout, left as is`;
  const changed = git(['diff', '--name-only', '--no-renames', 'HEAD', sha]);
  if (changed.status !== 0 || changed.stdout.split('\n').filter(Boolean).some((file) => !/^(?:docs\/|\.agents\/rules\/learned\/)/.test(file))) return 'code reached the integration branch since the pass started, left as is until the next night';
  if (git(['checkout', '--quiet', '--detach', sha]).status !== 0) return `checkout of ${sha.slice(0, 12)} failed, left as is`;
  return `checkout moved to ${sha.slice(0, 12)}`;
}

/** Admission persists the handoff; each pass retries until its URL is saved. */
export function ensureWorkIssues(candidates = listCandidates(), { run = gh, save = saveCandidate } = {}) {
  const urls = [];
  for (const candidate of candidates.filter((entry) => entry.type !== 'rule' && entry.status === 'admitted' && !entry.workIssue)) {
    const number = Number(/\/issues\/(\d+)$/.exec(candidate.issue ?? '')?.[1]);
    if (!number) throw new Error(`admitted candidate ${candidate.id} has no decision issue`);
    const issue = findWorkIssue(candidate.id, run) ?? createIssue(workIssue(candidate, { number }), run);
    save({ ...candidate, workIssue: issue.url });
    urls.push(issue.url);
  }
  return urls;
}

function draft(newEvents) {
  const since = addDays(new Date(), -14).toISOString();
  const events = readRecords('events', { since }).filter((event) => event.kind === 'failure');
  const pending = events.filter((event) => !(readDocument('state/drafted.json')?.keys ?? []).includes(event.key));
  if (pending.length === 0) return `no undrafted event (${newEvents.length} new)`;
  const recent = listCandidates().filter((candidate) => ['drafted', 'ready', 'published', 'canary-failed'].includes(candidate.status) || candidate.createdAt >= addDays(new Date(), -30).toISOString());
  // Read, Grep and Glob only, no MCP server, and no permission bypass: the
  // healer cannot run a command, write a file or reach a connector, and the
  // guard refuses anything else in a healing run.
  const given = pending.slice(0, 40);
  const session = claude(['-p', draftingPrompt(given, recent), '--agent', 'healer', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--permission-mode', 'default', '--max-turns', '80'], { cwd: repoRoot, env: { [LOOP_ENV.healing]: '1', [LOOP_ENV.nightly]: '1' }, timeoutMinutes: 45 });
  // A failed run (quota, timeout, turn limit) records nothing and keeps its
  // events for the next night.
  if (session.status !== 0) return `${given.length} event(s) given to the healer, exit ${session.status}; kept for the next run`;
  const outcomes = healerCandidates(session.stdout).map((input) => {
    const { errors, candidate } = buildCandidate(input);
    if (errors) return `rejected (${errors.join('; ').slice(0, 120)})`;
    saveCandidate(candidate);
    return `${candidate.id} ${candidate.status}`;
  });
  writeDocument('state/drafted.json', { keys: [...new Set([...(readDocument('state/drafted.json')?.keys ?? []), ...given.map((event) => event.key)])].slice(-500) });
  return `${given.length} event(s) given to the healer, exit ${session.status}; candidates: ${outcomes.join(', ') || 'none'}`;
}

async function replay() {
  const cases = loadCases(repoRoot);
  const results = [];
  for (const candidate of listCandidates('drafted').filter((entry) => entry.type === 'rule').slice(0, LIMITS.candidatesPerNight)) {
    const report = await runCanaries({ candidate, cases, root: repoRoot, ref: `origin/${integrationBranch()}` });
    const at = new Date().toISOString();
    writeDocument(`canaries/${candidate.id}/${at.replace(/[:.]/g, '-')}.json`, { at, ...report });
    setStatus(candidate, report.verdict === 'pass' ? 'ready' : 'canary-failed', { canary: { verdict: report.verdict, ref: report.ref, results: report.results.map((entry) => ({ case: entry.case, outcome: entry.outcome })) }, note: report.verdict });
    results.push(`${candidate.id} ${report.verdict}`);
  }
  return results.length > 0 ? results.join(', ') : 'no rule candidate to replay';
}

function publish() {
  const ready = publishable(listCandidates());
  if (ready.length === 0) return 'nothing to publish';
  ensureLabels();
  return ready.map((candidate) => {
    const issue = createIssue(candidateIssue(candidate, candidate.canary ?? null));
    setStatus(candidate, 'published', { issue: issue.url });
    return issue.url;
  });
}

/** Rules due for review that have no retire-or-keep issue open or awaiting admission. */
export function rulesToReview(due, openNames, pendingNames) {
  return due.filter((rule) => !openNames.has(rule.name) && !pendingNames.has(rule.name));
}

function retireReviews() {
  // A closed issue whose decision has not landed yet still counts: opening
  // another one would orphan the maintainer's decision.
  const pending = new Set([...decidedTonight, ...pendingDecisions().filter((decision) => decision.retireRule && !decision.closedByCode).map((decision) => decision.retireRule)]);
  const due = rulesToReview(dueRules(repoRoot), openRetireReviews(), pending);
  if (due.length === 0) return 'no rule due';
  ensureLabels();
  // Remember which issue asks about which rule: only that issue decides it.
  const opened = readDocument('state/retire-issues.json') ?? {};
  const urls = due.map((rule) => {
    const { url } = createIssue(retireIssue(rule));
    opened[rule.name] = url;
    return url;
  });
  writeDocument('state/retire-issues.json', opened);
  return urls;
}

function digest(now = new Date()) {
  const week = isoWeek(now);
  const file = `digests/${week}.md`;
  if (existsSync(path.join(journalRoot(), file))) return `${file} exists`;
  const since = addDays(now, -LIMITS.frictionWindowDays).toISOString();
  mkdirSync(path.join(journalRoot(), 'digests'), { recursive: true });
  writeFileSync(path.join(journalRoot(), file), digestMarkdown({ week, events: readRecords('events', { since }).filter((event) => event.kind === 'failure'), candidates: listCandidates(), ledgerRows: ledgerReport(readRecords('ledger', { since: addDays(now, -56).toISOString() })) }));
  return file;
}

function refreshDependencies() {
  // Only an npm repository with a lockfile gets its dependencies refreshed.
  if (!existsSync(path.join(repoRoot, 'package-lock.json'))) return 'no package-lock.json: dependencies skipped';
  const state = readDocument('state/nightly-deps.json');
  const stamp = run('git', ['hash-object', 'package-lock.json']).trim();
  if (state?.stamp === stamp && existsSync(path.join(repoRoot, 'node_modules'))) return 'dependencies up to date';
  run('npm', ['ci', '--no-audit', '--no-fund', '--prefer-offline'], { timeout: 20 * 60_000 });
  writeDocument('state/nightly-deps.json', { stamp });
  return 'npm ci done';
}

export async function nightly() {
  const release = acquireLock();
  const summary = { startedAt: new Date().toISOString(), ref: run('git', ['rev-parse', 'HEAD']).trim() };
  try {
    step(summary, 'journalPull', () => syncJournal({ pullOnly: true }));
    step(summary, 'dependencies', refreshDependencies);
    let events = [];
    step(summary, 'detect', () => {
      events = detect();
      return `${events.length} new failure event(s)`;
    });
    // Apply the maintainer's decisions before asking about due rules again.
    step(summary, 'admission', admit);
    step(summary, 'workIssues', () => ensureWorkIssues());
    step(summary, 'retireReviews', retireReviews);
    step(summary, 'drafting', () => draft(events));
    await asyncStep(summary, 'canaries', replay);
    step(summary, 'publish', publish);
    step(summary, 'digest', () => digest());
    summary.finishedAt = new Date().toISOString();
    writeDocument('state/nightly-last.json', summary);
    step(summary, 'journalPush', () => syncJournal());
  } finally {
    release();
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = await nightly();
  process.exit(Object.values(summary).some((value) => typeof value === 'string' && value.startsWith('failed:')) ? 1 : 0);
}
