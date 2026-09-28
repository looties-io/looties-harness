#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { effectiveRecords } from '../hooks/healing.mjs';
import { appendRecord, listDocuments, readDocument, readRecords, writeDocument } from '../hooks/journal.mjs';
import { LIMITS, addDays, gh, harnessConfig, isoWeek, repoRoot, run } from './lib.mjs';

// Failure detection of the self-healing loop, run by the nightly pass. It
// turns what happened since the last run into `failure` events in the agent
// journal: red CI runs, reverts on the integration branch, issues raised by
// the repository's robots (the skill signals, labelled with one of the
// config's `signalLabels`), sessions that ended with pre-commit failures,
// guard denials or corrections, recurring gaps in the interpretation ledger,
// and protections that keep blocking (the loosening signal). A user
// correction counts only with an artifact from the same session.
// Owned by docs/agent-harness.md#self-healing-loop.

const LOOP_BRANCH = /^(?:canary|healing)\//;
const LOOP_WORKTREE = /harness-(?:canary|healing)-|harness-nightly\//;
const isLoopRun = (branch, cwd) => LOOP_BRANCH.test(branch ?? '') || LOOP_WORKTREE.test(cwd ?? '');

/** Labels of the issues the repository's own robots open (`signalLabels` in the config). */
export function signalLabels(root = repoRoot) {
  const labels = harnessConfig(root).signalLabels;
  return Array.isArray(labels) ? labels.filter((label) => typeof label === 'string' && label.trim()) : [];
}

/**
 * Pure: the failure events the sources prove, minus the keys already
 * recorded. `sources` holds ciRuns, reverts, botIssues, guardEvents,
 * sessions and ledger, as plain arrays.
 */
export function detectFailures(sources, { now = new Date(), since, knownKeys = new Set() }) {
  const events = [];
  const add = (event) => {
    if (!knownKeys.has(event.key) && !events.some((known) => known.key === event.key)) events.push({ kind: 'failure', ...event });
  };
  for (const runRecord of sources.ciRuns ?? []) {
    add({ key: `ci-red:${runRecord.databaseId}`, source: 'ci', summary: `CI failed on ${runRecord.headBranch}: ${runRecord.displayTitle}`, url: runRecord.url, branch: runRecord.headBranch, sha: runRecord.headSha });
  }
  for (const revert of sources.reverts ?? []) add({ key: `revert:${revert.sha}`, source: 'git', summary: revert.subject, sha: revert.sha });
  for (const issue of sources.botIssues ?? []) {
    add({ key: `bot-issue:${issue.number}`, source: 'github', summary: issue.title, url: issue.url, labels: (issue.labels ?? []).map((label) => label.name ?? label), skillSignal: true });
  }
  // Relabels correct the class a reply was first given.
  const ledger = effectiveRecords(sources.ledger ?? []);
  for (const session of sources.sessions ?? []) {
    // The loop's own runs (canary and admission worktrees) are not evidence.
    if (session.at < since || isLoopRun(session.branch, session.cwd)) continue;
    const denials = session.guard?.deny ?? 0;
    const records = ledger.filter((record) => record.sessionId === session.sessionId);
    const corrections = records.length ? records.filter((record) => ['corrected', 'rejected'].includes(record.class)).length : (session.ledger?.corrected ?? 0) + (session.ledger?.rejected ?? 0);
    const precommit = session.precommitFailures?.length ?? 0;
    // A correction alone is an opinion; with a pre-commit failure or a guard
    // denial in the same session it is corroborated.
    const corroborated = corrections > 0 && (precommit > 0 || denials > 0);
    if (precommit === 0 && denials === 0 && !corroborated) continue;
    add({
      key: `session:${session.sessionId}`,
      source: 'session',
      summary: `Session on ${session.branch || 'unknown branch'} (${session.tool}, L${session.level ?? '?'}): ${precommit} pre-commit failure(s), ${denials} guard denial(s), ${corrections} correction(s)`,
      sessionId: session.sessionId,
      skills: session.skills ?? [],
      precommitFailures: session.precommitFailures ?? [],
      guardReasons: session.guardReasons ?? [],
      corroboratedCorrection: corroborated,
    });
  }
  const windowStart = addDays(now, -LIMITS.frictionWindowDays).toISOString();
  const byRule = new Map();
  for (const event of sources.guardEvents ?? []) {
    // Production confirmations ask by design, every time: never a friction signal.
    if (event.kind !== 'guard' || event.at < windowStart || String(event.rule).startsWith('production-confirmations') || isLoopRun('', event.cwd)) continue;
    byRule.set(event.rule, [...(byRule.get(event.rule) ?? []), event]);
  }
  for (const [rule, hits] of byRule) {
    if (hits.length < LIMITS.frictionEvents) continue;
    add({ key: `friction:${rule}:${isoWeek(now)}`, source: 'guard', summary: `${hits.length} ${hits[0].decision === 'deny' ? 'denials' : 'confirmations'} in ${LIMITS.frictionWindowDays} days: ${rule}`, rule, count: hits.length, samples: hits.slice(-5).map((hit) => hit.command) });
  }
  const gaps = ledger.filter((record) => record.at >= windowStart && ['corrected', 'rejected'].includes(record.class));
  if (gaps.length >= LIMITS.frictionEvents) {
    add({ key: `ledger-gap:${isoWeek(now)}`, source: 'ledger', summary: `${gaps.length} restatements corrected or rejected in ${LIMITS.frictionWindowDays} days`, samples: gaps.slice(-8).map((record) => ({ restatement: record.restatement, reply: String(record.reply).slice(0, 400), class: record.class })) });
  }
  return events;
}

function lines(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function collectSources({ since, now = new Date(), root = repoRoot }) {
  const day = since.slice(0, 10);
  const config = harnessConfig(root);
  const integration = config.branches.integration;
  const safe = (read) => {
    try {
      return read();
    } catch (error) {
      console.warn(`[detect] source skipped: ${String(error?.message ?? error).split('\n')[0]}`);
      return [];
    }
  };
  return {
    ciRuns: safe(() => JSON.parse(gh(['run', 'list', '--workflow', config.ci.workflow, '--status', 'failure', '--created', `>=${day}`, '--limit', '50', '--json', 'databaseId,headBranch,headSha,displayTitle,url,createdAt,event'], { cwd: root }))),
    reverts: safe(() => {
      run('git', ['fetch', '--quiet', 'origin', integration], { cwd: root });
      return lines(run('git', ['log', `origin/${integration}`, `--since=${since}`, '--grep=^Revert', '--format=%H%x09%s'], { cwd: root })).map((line) => ({ sha: line.split('\t')[0], subject: line.split('\t')[1] }));
    }),
    botIssues: safe(() => signalLabels(root).flatMap((label) => JSON.parse(gh(['issue', 'list', '--state', 'all', '--label', label, '--search', `created:>=${day}`, '--limit', '20', '--json', 'number,title,labels,url,createdAt'], { cwd: root })))),
    guardEvents: readRecords('events', { since: addDays(now, -LIMITS.frictionWindowDays).toISOString() }).filter((event) => event.kind === 'guard'),
    sessions: [...new Set([since.slice(0, 7), now.toISOString().slice(0, 7)])].flatMap((month) => listDocuments(`sessions/${month}`)),
    ledger: readRecords('ledger', { since: addDays(now, -LIMITS.frictionWindowDays).toISOString() }),
  };
}

export function detect({ now = new Date(), root = repoRoot } = {}) {
  const state = readDocument('state/detect.json') ?? {};
  const since = state.lastRun ?? addDays(now, -7).toISOString();
  const knownKeys = new Set(readRecords('events', { since: addDays(now, -60).toISOString() }).filter((event) => event.kind === 'failure').map((event) => event.key));
  const events = detectFailures(collectSources({ since, now, root }), { now, since, knownKeys });
  for (const event of events) appendRecord('events', event, { now });
  writeDocument('state/detect.json', { lastRun: now.toISOString(), found: events.length });
  return events;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const events = detect();
  console.log(`[detect] ${events.length} new failure event(s)`);
  for (const event of events) console.log(`- ${event.key}: ${event.summary}`);
}
