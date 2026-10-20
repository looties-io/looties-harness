#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, hash, hasText, id, isSha, jsonFile, options, read, stateRoot, update } from './store.mjs';

const KEY = 'hardening';
const domains = ['quality', 'security'];
const timestamp = (value) => hasText(value) && Number.isFinite(Date.parse(value));
// Unknown files count as code. Only clearly documentary assets are excluded.
export const isCode = (file) => /^(?:\.agents\/|\.github\/|\.claude\/|\.codex\/)|(?:^|\/)(?:AGENTS|CLAUDE)\.md$/.test(file) || !/^docs\/.*\.(?:txt|png|jpe?g|svg|gif|pdf)$|(?:^|\/)(?:README|CHANGELOG|LICENSE)(?:\.[^/]*)?$|\.(?:md|mdx|rst)$/i.test(file);
const required = (state) => { if (!state) throw new Error('Initialize a documented baseline first'); return state; };

export function initialize(root, { base, since, reference, timezone = 'Europe/Paris' }) {
  if (!isSha(base) || !timestamp(since) || !hasText(reference)) throw new Error('Baseline needs a full commit, timestamp and previous audit or bootstrap reference');
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  return update(root, KEY, 0, () => ({ baseline: { head: base, since, reference }, timezone, campaign: null, findings: [], history: [] }));
}

export function validateSnapshot(snapshot, baseline) {
  if (snapshot.complete !== true || snapshot.base !== baseline.head || snapshot.since !== baseline.since || !isSha(snapshot.head) || !timestamp(snapshot.until) || Date.parse(snapshot.until) <= Date.parse(baseline.since)) throw new Error('Incomplete or mismatched history; never interpret it as zero activity');
  if (!Array.isArray(snapshot.prs) || !Array.isArray(snapshot.activity)) throw new Error('Missing history');
  const ids = new Set();
  for (const pr of snapshot.prs) {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || ids.has(pr.number) || !isSha(pr.sha) || !timestamp(pr.mergedAt) || !Array.isArray(pr.files) || !pr.files.length || !pr.files.every(hasText)) throw new Error('Malformed or duplicate PR history');
    if (Date.parse(pr.mergedAt) <= Date.parse(snapshot.since) || Date.parse(pr.mergedAt) > Date.parse(snapshot.until)) throw new Error('PR outside the frozen interval');
    ids.add(pr.number);
  }
  for (const commit of snapshot.activity) {
    if (!isSha(commit.sha) || !timestamp(commit.at) || !Array.isArray(commit.files) || !commit.files.every(hasText)) throw new Error('Malformed activity history');
  }
}

export function due(snapshot, baseline, timezone) {
  validateSnapshot(snapshot, baseline);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Set(snapshot.activity.filter((c) => Date.parse(c.at) > Date.parse(snapshot.since) && Date.parse(c.at) <= Date.parse(snapshot.until) && c.files.some(isCode)).map((c) => date.format(new Date(c.at))));
  const prs = snapshot.prs.filter((pr) => pr.files.some(isCode));
  return { due: days.size >= 7 || prs.length >= 50, activeDays: days.size, codePRs: prs.length };
}

export function reserve(root, revision, snapshot) {
  return update(root, KEY, revision, (state) => {
    required(state);
    if (state.campaign) throw new Error('A campaign already owns this repository; resume it');
    const threshold = due(snapshot, state.baseline, state.timezone);
    if (!threshold.due) throw new Error('Hardening is not due');
    state.campaign = { id: hash(JSON.stringify(snapshot)).slice(0, 24), snapshot, threshold, dispatch: { status: 'prepared' }, owner: null, assessments: {} };
    return state;
  });
}

export function claim(root, revision, owner) {
  if (!hasText(owner)) throw new Error('An originating session reference is required');
  return update(root, KEY, revision, (state) => {
    if (!required(state).campaign) throw new Error('No campaign to claim');
    if (state.campaign.owner && state.campaign.owner !== owner) throw new Error('Campaign belongs to another session; reconcile before transferring');
    state.campaign.owner = owner; state.campaign.dispatch = { status: 'confirmed', reference: owner };
    for (const item of state.findings.filter((f) => f.campaign === state.campaign.id && f.status !== 'resolved')) item.owner = owner;
    return state;
  });
}

// Explicit reconciliation, never an age-based retry: an ambiguous launch must be inspected first.
export function recover(root, revision, { previousOwner, evidence }) {
  if (!hasText(evidence)) throw new Error('Recovery needs evidence that the previous launch/session is stopped and effects reconciled');
  return update(root, KEY, revision, (state) => {
    const campaign = required(state).campaign;
    if (!campaign || campaign.owner !== previousOwner || campaign.dispatch.status === 'ready') throw new Error('Reload the campaign before recovery');
    campaign.recoveries ??= [];
    campaign.recoveries.push({ previousOwner, evidence, at: new Date().toISOString() });
    campaign.owner = null; campaign.dispatch = { status: 'ready', evidence };
    return state;
  });
}

export function offerRecovery(root, revision) {
  return update(root, KEY, revision, (state) => {
    if (required(state).campaign?.dispatch.status !== 'ready') throw new Error('Campaign is not reconciled for another dispatch');
    state.campaign.dispatch = { status: 'prepared', recovery: state.campaign.recoveries.length }; return state;
  });
}

function owned(state, owner) {
  if (!required(state).campaign?.owner || state.campaign.owner !== owner) throw new Error('Only the campaign owner may update its evidence');
}

function artifact(repo, path) {
  if (!hasText(path) || isAbsolute(path)) throw new Error('Evidence must be repository-relative');
  const file = realpathSync(resolve(repo, path)); const rel = relative(realpathSync(repo), file);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Evidence escapes repository');
  const content = readFileSync(file);
  if (!content.length) throw new Error('Empty evidence');
  return { path, digest: hash(content) };
}

export function assess(repo, root, revision, owner, input) {
  if (!domains.includes(input.domain) || !isSha(input.head) || !Array.isArray(input.reports) || !input.reports.length || !Array.isArray(input.coverage) || !input.coverage.length || !input.coverage.every((c) => hasText(c.control) && ['passed', 'failed', 'unvalidated'].includes(c.result) && hasText(c.evidence))) throw new Error('Assessment requires reports and explicit control outcomes, including unvalidated controls');
  const reports = input.reports.map((p) => artifact(repo, p));
  const mission = read(root, `mission-${id(input.verificationMission)}`);
  const check = mission?.checks.at(-1);
  if (!check || check.head !== input.head || !Number.isInteger(check.exitCode) || check.error || !check.cleanBefore || !check.clean) throw new Error('Run the baseline matrix through mission verify at the frozen revision before recording an assessment');
  return update(root, KEY, revision, (state) => {
    owned(state, owner);
    if (input.head !== state.campaign.snapshot.head) throw new Error('Assessment must cover the frozen integrated revision');
    if (state.campaign.assessments[input.domain]) throw new Error('Baseline assessment is immutable');
    state.campaign.assessments[input.domain] = { head: input.head, reports, coverage: input.coverage, verification: { mission: mission.id, revision: mission.revision, check: mission.checks.length - 1 } };
    return state;
  });
}

export function finding(root, revision, owner, input) {
  id(input.id);
  return update(root, KEY, revision, (state) => {
    required(state);
    const previous = state.findings.find((f) => f.id === input.id);
    if (!previous) {
      owned(state, owner);
      if (!domains.includes(input.domain) || !['confirmed', 'configuration', 'coverage', 'theoretical'].includes(input.kind) || !hasText(input.evidence) || !hasText(input.nextAction)) throw new Error('Finding needs classification, reproduction/evidence and next action');
      state.findings.push({ ...input, owner, campaign: state.campaign.id, status: 'open' });
    } else {
      if (previous.owner !== owner) throw new Error('Finding belongs to another owner');
      if (!['open', 'blocked', 'resolved'].includes(input.status) || !hasText(input.evidence) || !hasText(input.nextAction)) throw new Error('Finding update needs evidence and next action');
      if (input.status === 'blocked' && !hasText(input.approvalReference)) throw new Error('Block only the affected action, with its approval reference');
      if (input.status === 'resolved') throw new Error('Resolve through verified mission evidence');
      Object.assign(previous, { status: input.status, evidence: input.evidence, nextAction: input.nextAction, approvalReference: input.approvalReference ?? null });
    }
    return state;
  });
}

export function resolveFinding(root, revision, owner, findingId, missionId) {
  const mission = read(root, `mission-${id(missionId)}`);
  if (mission?.status !== 'completed' || !mission.checks.at(-1)?.pass) throw new Error('A completed remediation mission with verification is required');
  return update(root, KEY, revision, (state) => {
    const item = required(state).findings.find((f) => f.id === findingId);
    if (!item || item.owner !== owner || !mission.acceptance.some((a) => a.includes(findingId))) throw new Error('Remediation must reference this finding and its owner');
    item.status = 'resolved'; item.remediation = { mission: missionId, revision: mission.revision, head: mission.head }; return state;
  });
}

export function completeAssessment(root, revision, owner) {
  return update(root, KEY, revision, (state) => {
    owned(state, owner); const campaign = state.campaign;
    if (!domains.every((d) => campaign.assessments[d])) throw new Error('Both baseline assessments must be executed before advancing coverage');
    // Every non-passing control has an explicit open remediation; a report alone cannot reset the counter.
    for (const [domain, assessment] of Object.entries(campaign.assessments)) {
      for (const c of assessment.coverage.filter((c) => c.result !== 'passed')) {
        if (!state.findings.some((f) => f.campaign === campaign.id && f.domain === domain && f.id === c.finding)) throw new Error(`Missing remediation for ${domain}: ${c.control}`);
      }
    }
    state.history.push(campaign);
    state.baseline = { head: campaign.snapshot.head, since: campaign.snapshot.until, reference: campaign.id };
    state.campaign = null;
    return state;
  });
}

function api(args, repo) {
  return JSON.parse(execFileSync('gh', ['api', ...args], { cwd: repo, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 }));
}

// Read every page. No gh search limit, no timestamp watermark before successful assessment.
export function collect(repo, state, ref, { request = api, now = () => new Date().toISOString() } = {}) {
  required(state);
  if (git(repo, ['rev-parse', '--is-shallow-repository']) !== 'false') throw new Error('Shallow history cannot prove cumulative coverage');
  const current = git(repo, ['rev-parse', ref]);
  git(repo, ['merge-base', '--is-ancestor', state.baseline.head, current]);
  const until = now();
  const repository = request(['repos/{owner}/{repo}'], repo).full_name;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid GitHub repository identity');
  const pulls = request([`repos/${repository}/pulls?state=closed&per_page=100`, '--paginate', '--slurp'], repo).flat();
  const prs = [];
  const branch = ref.replace(/^refs\/remotes\//, '').replace(/^origin\//, '').replace(/^refs\/heads\//, '');
  if (branch === 'HEAD' || isSha(branch)) throw new Error('Collect against the named integration branch, not HEAD or a detached commit');
  for (const pr of pulls.filter((p) => p.base?.ref === branch && p.merged_at && Date.parse(p.merged_at) > Date.parse(state.baseline.since) && Date.parse(p.merged_at) <= Date.parse(until))) {
    if (!isSha(pr.merge_commit_sha)) throw new Error('Missing merge revision');
    try { git(repo, ['merge-base', '--is-ancestor', pr.merge_commit_sha, current]); }
    catch { throw new Error(`Merged PR #${pr.number} is absent from ${ref}; fetch and reconcile branches before proceeding`); }
    const files = request([`repos/${repository}/pulls/${pr.number}/files?per_page=100`, '--paginate', '--slurp'], repo).flat();
    // GitHub caps this endpoint at 3,000 files; refuse the cap instead of claiming completeness.
    if (files.length >= 3000) throw new Error(`PR #${pr.number} needs an uncapped file inventory`);
    prs.push({ number: pr.number, sha: pr.merge_commit_sha, mergedAt: pr.merged_at, title: pr.title, url: pr.html_url, files: files.flatMap((f) => f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]) });
  }
  const commits = git(repo, ['log', '--first-parent', '--format=%H', `${state.baseline.head}..${current}`]).split('\n').filter(Boolean);
  const activity = commits.map((sha) => ({ sha, at: git(repo, ['show', '-s', '--format=%cI', sha]), files: git(repo, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-m', '--no-renames', sha]).split('\n').filter(Boolean) }));
  const snapshot = { complete: true, repository, base: state.baseline.head, since: state.baseline.since, head: current, until, prs, activity };
  validateSnapshot(snapshot, state.baseline); return snapshot;
}

export function main(args = process.argv.slice(2)) {
  const [command, ...flags] = args;
  if (!command || command === '--help') { console.log('hardening.mjs init|show|scan|precheck|claim|recover|assess|finding|resolve|complete --repo PATH [--ref REF] [--revision N] [--owner SESSION] [--file JSON] [--id FINDING --mission ID] [--state-root PATH]'); return 0; }
  const o = options(flags, ['repo', 'state-root', 'revision', 'ref', 'owner', 'file', 'id', 'mission']); const repo = resolve(o.repo || process.cwd()); const root = o['state-root'] || stateRoot(repo); const revision = Number(o.revision);
  let result;
  switch (command) {
    case 'init': result = initialize(root, jsonFile(o.file)); break;
    case 'show': result = required(read(root, KEY)); break;
    case 'scan': case 'precheck': {
      const state = required(read(root, KEY));
      if (state.campaign) {
        if (command === 'precheck' && state.campaign.dispatch.status === 'ready') { result = offerRecovery(root, state.revision); break; }
        console.log(JSON.stringify({ action: 'resume-existing-campaign', campaign: state.campaign })); return 3;
      }
      const snapshot = collect(repo, state, o.ref || 'HEAD'); const threshold = due(snapshot, state.baseline, state.timezone);
      result = { ...threshold, snapshot, openFindings: state.findings.filter((f) => f.status !== 'resolved') };
      if (command === 'precheck') {
        if (!threshold.due) { console.log(JSON.stringify(result)); return 3; }
        result = reserve(root, state.revision, snapshot);
      }
      break;
    }
    case 'claim': result = claim(root, revision, o.owner); break;
    case 'recover': result = recover(root, revision, jsonFile(o.file)); break;
    case 'assess': result = assess(repo, root, revision, o.owner, jsonFile(o.file)); break;
    case 'finding': result = finding(root, revision, o.owner, jsonFile(o.file)); break;
    case 'resolve': result = resolveFinding(root, revision, o.owner, o.id, o.mission); break;
    case 'complete': result = completeAssessment(root, revision, o.owner); break;
    default: throw new Error('Unknown hardening command');
  }
  console.log(JSON.stringify(result, null, 2)); return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(`Hardening unknown/failed: ${error.message}`); process.exitCode = 2; }
}
