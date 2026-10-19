// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { git, head, read } from '../harness/runtime/store.mjs';
import { initialize, reserve } from '../harness/runtime/hardening.mjs';
import { main as schedule } from '../harness/runtime/schedule.mjs';

let directory;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function fixture() {
  for (const name of Object.keys(process.env).filter((name) => name.startsWith('GIT_'))) vi.stubEnv(name, undefined);
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'lstack-flow-')));
  const repo = join(directory, 'repo'); mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'dev']); git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'fixture@example.test']);
  return { repo, state: join(directory, 'state') };
}
function commit(repo) { git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'fixture change']); }

it('installed CLI carries a real failing security contract through restart, correction and verified closure', () => {
  const { repo, state } = fixture();
  execFileSync(process.execPath, [resolve('install.mjs'), repo], { stdio: 'pipe' });
  writeFileSync(join(repo, 'permission.mjs'), 'export const allowed = (actor, target) => true;\n');
  writeFileSync(join(repo, 'check.mjs'), "import { strict as assert } from 'node:assert';\nimport { allowed } from './permission.mjs';\nassert.equal(allowed('tenant-a', 'tenant-a'), true);\nassert.equal(allowed('tenant-a', 'tenant-b'), false);\n");
  commit(repo); const frozen = head(repo);
  const cli = (module, command, options = {}, expected = 0) => {
    const flags = Object.entries(options).flatMap(([k, v]) => [`--${k}`, String(v)]);
    const result = spawnSync(process.execPath, [join(repo, `.agents/runtime/${module}.mjs`), command, '--repo', repo, '--state-root', state, ...flags], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stderr).toBe(expected); return JSON.parse(result.stdout);
  };
  const input = (name, value) => { const file = join(directory, `${name}.json`); writeFileSync(file, JSON.stringify(value)); return file; };
  const mandate = (id, skills, acceptance) => ({ id, skills, acceptance, summary: 'Close a reproduced tenant-boundary defect', scope: ['permission.mjs'], authorization: { reference: 'approved fixture campaign', actions: ['local corrections', 'tests'] } });
  let baseline = cli('mission', 'begin', { file: input('baseline', mandate('baseline', [], ['Execute baseline matrix'])) });
  baseline = cli('mission', 'verify', { id: 'baseline', revision: baseline.revision, argv: JSON.stringify([process.execPath, 'check.mjs']) }, 1);
  expect(baseline.checks[0].output).toContain('AssertionError');
  let campaign = initialize(state, { base: frozen, since: '2026-10-01T00:00:00Z', reference: 'Synthetic retrospective start' });
  campaign = reserve(state, campaign.revision, { complete: true, base: frozen, head: frozen, since: campaign.baseline.since, until: '2026-10-10T00:00:00Z', activity: [], prs: Array.from({ length: 50 }, (_, i) => ({ number: i + 1, sha: frozen, mergedAt: '2026-10-02T00:00:00Z', files: ['permission.mjs'] })) });
  campaign = cli('hardening', 'claim', { revision: campaign.revision, owner: 'campaign-session' });
  campaign = cli('hardening', 'finding', { revision: campaign.revision, owner: 'campaign-session', file: input('finding', { id: 'TENANT1', domain: 'security', kind: 'confirmed', evidence: 'check.mjs rejects cross-tenant access; baseline fails', nextAction: 'Use the existing permission owner and verify both cases' }) });
  writeFileSync(join(repo, 'assessment.md'), 'Baseline: cross-tenant request incorrectly allowed. Local synthetic inputs only.\n');
  for (const domain of ['quality', 'security']) campaign = cli('hardening', 'assess', { revision: campaign.revision, owner: 'campaign-session', file: input(`assessment-${domain}`, { domain, head: frozen, verificationMission: 'baseline', reports: ['assessment.md'], coverage: [{ control: domain === 'security' ? 'tenant-isolation' : 'single-implementation-owner', result: domain === 'security' ? 'failed' : 'passed', evidence: 'Recorded baseline command and inspected sole permission owner', ...(domain === 'security' ? { finding: 'TENANT1' } : {}) }] }) });
  campaign = cli('hardening', 'complete', { revision: campaign.revision, owner: 'campaign-session' });
  expect(campaign.findings[0].status).toBe('open');
  const skill = '.agents/skills/lstack-workflow/SKILL.md';
  let mission = cli('mission', 'begin', { file: input('remediation', mandate('fix', [skill], ['Resolve TENANT1 without changing same-tenant access'])) });
  const delivered = cli('mission', 'skill', { id: 'fix', revision: mission.revision, skill });
  expect(delivered.content).toBe(readFileSync(join(repo, skill), 'utf8'));
  // A new process resumes from disk; there is no in-memory conversation dependency.
  mission = cli('mission', 'resume', { id: 'fix', revision: delivered.revision });
  writeFileSync(join(repo, 'permission.mjs'), 'export const allowed = (actor, target) => actor === target;\n'); commit(repo);
  mission = cli('mission', 'applied', { id: 'fix', revision: mission.revision, file: input('applied', { path: skill, digest: delivered.digest, application: 'Preserved baseline, corrected the existing owner, checked denied and legitimate requests' }) });
  mission = cli('mission', 'verify', { id: 'fix', revision: mission.revision, skill, argv: JSON.stringify([process.execPath, 'check.mjs']) });
  mission = cli('mission', 'checkpoint', { id: 'fix', revision: mission.revision, file: input('checkpoint', { remaining: [] }) });
  mission = cli('mission', 'finish', { id: 'fix', revision: mission.revision });
  expect(mission.status).toBe('completed'); expect(mission.head).not.toBe(frozen);
  campaign = cli('hardening', 'resolve', { revision: campaign.revision, owner: 'campaign-session', id: 'TENANT1', mission: 'fix' });
  expect(campaign.findings[0].status).toBe('resolved');
  expect(campaign.history[0].snapshot.head).toBe(frozen);
  expect(campaign.baseline.head).toBe(frozen); // Later changes remain in the next cohort.
}, 15000);

it('scheduled precheck fetches but never dispatches before the reviewed runtime is deployed', () => {
  const { repo, state } = fixture(); writeFileSync(join(repo, 'README.md'), '# Fixture'); commit(repo);
  git(repo, ['clone', '--bare', '.', join(directory, 'remote.git')]); git(repo, ['remote', 'add', 'origin', join(directory, 'remote.git')]);
  expect(schedule(['--repo', repo, '--ref', 'origin/dev', '--state-root', state])).toBe(3);
  expect(read(state, 'hardening')).toBeNull();
});
