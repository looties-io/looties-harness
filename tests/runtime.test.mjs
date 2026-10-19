// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, head, read, missionEvidence } from '../harness/runtime/store.mjs';
import { begin, checkpoint, deliverSkill, applySkill, effect, resume, verify, completionFailures, finish } from '../harness/runtime/mission.mjs';
import { assess, claim, collect, completeAssessment, due, finding, initialize, isCode, offerRecovery, recover, reserve, resolveFinding } from '../harness/runtime/hardening.mjs';

let repo, root, directory;
const skill = '.agents/skills/example/SKILL.md';
const commit = () => { git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'fixture']); };
beforeEach(() => {
  // A pre-commit hook exports GIT_DIR/GIT_INDEX_FILE; never let fixtures use the real repository.
  for (const name of Object.keys(process.env).filter((name) => name.startsWith('GIT_'))) vi.stubEnv(name, undefined);
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'lstack-runtime-')));
  repo = join(directory, 'repo'); root = join(directory, 'state'); mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'dev']); git(repo, ['config', 'user.name', 'Fixture']); git(repo, ['config', 'user.email', 'fixture@example.test']);
  mkdirSync(join(repo, '.agents/skills/example'), { recursive: true }); writeFileSync(join(repo, skill), '# Skill\nRead the actual call site.\n'); commit();
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const start = (skills = [skill], acceptance = ['Working behavior']) => begin(repo, root, { id: 'work', summary: 'Implement behavior', acceptance, scope: ['src'], authorization: { reference: 'user-message-1', actions: ['edit', 'test'] }, skills });
const command = [process.execPath, '-e', 'console.log("behavior verified")'];

describe('durable missions', () => {
  it('links explicit session references to the journal without calling mentions verified use', () => {
    let s = start();
    expect(missionEvidence(repo, 'session-1', root).status).toBe('no-linked-mission');
    s = checkpoint(root, 'work', s.revision, { sessionIds: ['session-1'] });
    expect(missionEvidence(repo, 'session-1', root).missions[0].skills[0].stage).toBe('requested');
    deliverSkill(repo, root, 'work', s.revision, skill);
    expect(missionEvidence(repo, 'session-1', root).missions[0].skills[0].stage).toBe('delivered');
    expect(missionEvidence(repo, 'unrelated-session', root).status).toBe('no-linked-mission');
  });
  it('delivers the whole skill, records application, executes verification and closes', () => {
    let s = start();
    const delivered = deliverSkill(repo, root, 'work', s.revision, skill);
    expect(delivered.content).toBe(readFileSync(join(repo, skill), 'utf8'));
    expect(() => verify(repo, root, 'work', delivered.revision, command, { skill })).toThrow(/Apply/);
    s = applySkill(root, 'work', delivered.revision, { path: skill, digest: delivered.digest, application: 'Inspected the production call site and ran its behavioral check' });
    s = verify(repo, root, 'work', s.revision, command, { skill });
    expect(s.checks[0].output).toContain('behavior verified');
    expect(completionFailures(repo, s)).toContain('Remaining work or unresolved blockers');
    s = checkpoint(root, 'work', s.revision, { remaining: [] });
    expect(finish(repo, root, 'work', s.revision).status).toBe('completed');
  });
  it('does not equate installed or delivered skills with application', () => {
    let s = start();
    s = verify(repo, root, 'work', s.revision, command);
    expect(completionFailures(repo, s).join()).toContain('Unverified skill');
    const d = deliverSkill(repo, root, 'work', s.revision, skill);
    expect(() => applySkill(root, 'work', d.revision, { path: skill, digest: 'wrong', application: 'claimed' })).toThrow(/digest/);
  });
  it('invalidates verification after a new revision or dirty changes', () => {
    let s = start([]); s = verify(repo, root, 'work', s.revision, command);
    writeFileSync(join(repo, 'changed.js'), 'export default 1;');
    expect(completionFailures(repo, s).join()).toContain('not clean'); commit();
    expect(completionFailures(repo, s).join()).toContain('current HEAD');
  });
  it('refuses a dirty-to-clean check as proof of the original revision', () => {
    let s = start([]); writeFileSync(join(repo, 'temporary'), 'dirty');
    s = verify(repo, root, 'work', s.revision, [process.execPath, '-e', 'require("fs").unlinkSync("temporary")']);
    expect(s.checks[0].pass).toBe(false);
  });
  it('records failed commands instead of allowing a previous green result to stand', () => {
    let s = start([]); s = verify(repo, root, 'work', s.revision, command);
    s = verify(repo, root, 'work', s.revision, [process.execPath, '-e', 'process.exit(3)']);
    expect(s.checks.at(-1).exitCode).toBe(3);
    expect(completionFailures(repo, s).join()).toContain('Latest verification');
  });
  it('reconciles an ambiguous write on resume without executing it twice', () => {
    let s = start([]);
    s = effect(root, 'work', s.revision, { id: 'publish', status: 'prepared', description: 'Publish PR', replaySafe: false });
    s = resume(repo, root, 'work', s.revision);
    expect(s.recovery).toEqual([{ id: 'publish', action: 'reconcile-external-outcome' }]);
    expect(() => effect(root, 'work', s.revision, { id: 'publish', status: 'prepared', description: 'Again', replaySafe: false })).toThrow(/duplicate/);
    expect(() => effect(root, 'work', s.revision, { id: 'publish', status: 'confirmed', description: 'A different write', evidence: 'claimed success' })).toThrow(/rewrite/);
    expect(completionFailures(repo, s)).toContain('Unreconciled effects');
  });
  it('keeps authorization immutable and decisions append-only', () => {
    let s = start([]);
    expect(() => checkpoint(root, 'work', s.revision, { authorization: { actions: ['merge'] } })).toThrow(/immutable/);
    s = checkpoint(root, 'work', s.revision, { decisions: [{ id: 'd1', reference: 'docs/decisions/1.md' }] });
    s = checkpoint(root, 'work', s.revision, { decisions: [{ id: 'd2', reference: 'docs/decisions/2.md', supersedes: 'd1' }] });
    expect(s.decisions).toHaveLength(2);
    expect(() => checkpoint(root, 'work', s.revision, { decisions: [{ id: 'd1', reference: 'overwrite' }] })).toThrow(/never overwritten/);
  });
  it('preserves targeted blockers while unrelated checks continue', () => {
    let s = start([]); s = checkpoint(root, 'work', s.revision, { blockers: [{ reason: 'Production approval', owner: 'maintainer', blocks: ['deploy'], nextAction: 'Finish isolated tests' }] });
    s = verify(repo, root, 'work', s.revision, command);
    expect(s.checks[0].pass).toBe(true); expect(s.status).toBe('active');
  });
  it('refuses stale writers and never steals a lock by age', () => {
    const s = start([]);
    expect(() => checkpoint(root, 'work', 0, { remaining: [] })).toThrow(/Revision conflict/);
    mkdirSync(join(root, 'mission-work.json.lock'));
    expect(() => checkpoint(root, 'work', s.revision, { remaining: [] })).toThrow(/locked/);
  });
  it('refuses state symlinks and corrupt state', () => {
    mkdirSync(root); symlinkSync(join(repo, skill), join(root, 'alias.json'));
    expect(() => read(root, 'alias')).toThrow(/links/);
    writeFileSync(join(root, 'broken.json'), '{'); expect(() => read(root, 'broken')).toThrow();
  });
});

const baseline = () => initialize(root, { base: head(repo), since: '2026-10-01T00:00:00Z', reference: 'Initial retrospective starts here' });
function snapshot(s, count = 50, days = 1) {
  return { complete: true, base: s.baseline.head, since: s.baseline.since, head: head(repo), until: '2026-10-10T00:00:00Z',
    prs: Array.from({ length: count }, (_, i) => ({ number: i + 1, sha: head(repo), mergedAt: '2026-10-02T12:00:00Z', files: ['src/a.js'] })),
    activity: Array.from({ length: days }, (_, i) => ({ sha: head(repo), at: `2026-10-${String(i + 2).padStart(2, '0')}T12:00:00Z`, files: ['src/a.js'] })) };
}
describe('cumulative hardening', () => {
  it('resumes a reconciled campaign once without replacing its cohort or assessment', () => {
    let s = baseline(); s = reserve(root, s.revision, snapshot(s)); s = claim(root, s.revision, 'old-session');
    const cohort = s.campaign.snapshot;
    expect(() => recover(root, s.revision, { previousOwner: 'old-session' })).toThrow(/evidence/);
    s = recover(root, s.revision, { previousOwner: 'old-session', evidence: 'Orca run ended; unresolved external effects inspected' });
    s = offerRecovery(root, s.revision);
    expect(() => offerRecovery(root, s.revision)).toThrow(/not reconciled/);
    s = claim(root, s.revision, 'new-session'); expect(s.campaign.snapshot).toEqual(cohort);
  });
  it('triggers at 50 code PRs or seven active days, not 49/six', () => {
    const s = baseline();
    expect(due(snapshot(s, 49, 6), s.baseline, s.timezone).due).toBe(false);
    expect(due(snapshot(s, 50, 1), s.baseline, s.timezone).due).toBe(true);
    expect(due(snapshot(s, 0, 7), s.baseline, s.timezone).due).toBe(true);
  });
  it('counts tests, workflows, instruction policies and unknown code, excludes docs only', () => {
    for (const file of ['tests/a.test.ts', '.github/workflows/ci.yml', '.agents/rules/base.md', 'Cargo.lock', 'requirements.txt', 'CMakeLists.txt', 'docs/build.js']) expect(isCode(file)).toBe(true);
    for (const file of ['README.md', 'docs/architecture.md']) expect(isCode(file)).toBe(false);
    const s = baseline(); const input = snapshot(s); input.prs.forEach((p) => p.files = ['docs/report.md']);
    expect(due(input, s.baseline, s.timezone).codePRs).toBe(0);
  });
  it('refuses incomplete or duplicated history instead of returning zero', () => {
    const s = baseline(); const input = snapshot(s); input.complete = false;
    expect(() => due(input, s.baseline, s.timezone)).toThrow(/Incomplete/);
    input.complete = true; input.prs.push(input.prs[0]); expect(() => due(input, s.baseline, s.timezone)).toThrow(/duplicate/);
  });
  it('reserves one immutable cohort and does not reset when started or dispatched', () => {
    let s = baseline(); const initial = s.baseline;
    s = reserve(root, s.revision, snapshot(s)); expect(s.baseline).toEqual(initial);
    expect(() => reserve(root, s.revision, snapshot(s))).toThrow(/already owns/);
    s = claim(root, s.revision, 'session-1');
    expect(() => claim(root, s.revision, 'session-2')).toThrow(/another session/);
    expect(() => completeAssessment(root, s.revision, 'session-1')).toThrow(/Both/);
  });
  it('advances assessed coverage while preserving remediation debt and subsequent PRs', () => {
    let s = baseline(); s = reserve(root, s.revision, snapshot(s)); s = claim(root, s.revision, 'session-1');
    const m = start([]); verify(repo, root, 'work', m.revision, command);
    writeFileSync(join(repo, 'report.md'), 'Executed matrix and reproduction evidence');
    s = finding(root, s.revision, 'session-1', { id: 'F1', domain: 'security', kind: 'confirmed', evidence: 'Isolated test fails', nextAction: 'Fix validation' });
    for (const domain of ['quality', 'security']) s = assess(repo, root, s.revision, 'session-1', { domain, head: head(repo), verificationMission: 'work', reports: ['report.md'], coverage: [{ control: 'boundary', result: domain === 'quality' ? 'passed' : 'failed', finding: 'F1', evidence: 'reproduction log' }] });
    s = completeAssessment(root, s.revision, 'session-1');
    expect(s.findings[0].status).toBe('open'); expect(s.history).toHaveLength(1); expect(s.campaign).toBeNull();
    const next = snapshot(s, 1); next.until = '2026-10-12T00:00:00Z'; next.prs[0].mergedAt = '2026-10-11T00:00:00Z';
    expect(due(next, s.baseline, s.timezone).codePRs).toBe(1);
  });
  it('cannot declare a finding resolved without a verified remediation mission', () => {
    let s = baseline(); s = reserve(root, s.revision, snapshot(s)); s = claim(root, s.revision, 'session-1');
    s = finding(root, s.revision, 'session-1', { id: 'F1', domain: 'quality', kind: 'confirmed', evidence: 'Failed behavior', nextAction: 'Fix' });
    expect(() => resolveFinding(root, s.revision, 'session-1', 'F1', 'work')).toThrow(/completed/);
    let m = start([], ['Resolve F1']); m = verify(repo, root, 'work', m.revision, command); m = checkpoint(root, 'work', m.revision, { remaining: [] }); finish(repo, root, 'work', m.revision);
    expect(resolveFinding(root, s.revision, 'session-1', 'F1', 'work').findings[0].status).toBe('resolved');
  });
  it('collector reads all pages and ignores PRs merged into other branches', () => {
    const s = baseline(); writeFileSync(join(repo, 'src.js'), 'export default 1;'); commit();
    const requests = [];
    const request = (args) => { requests.push(args); if (args[0] === 'repos/{owner}/{repo}') return { full_name: 'example/project' };
      if (args[0].includes('/files')) return [[{ filename: 'src.js' }], [{ filename: 'old.js' }]];
      return [[{ number: 1, base: { ref: 'dev' }, merged_at: '2026-10-02T00:00:00Z', merge_commit_sha: head(repo) }], [{ number: 2, base: { ref: 'release' }, merged_at: '2026-10-02T00:00:00Z', merge_commit_sha: 'a'.repeat(40) }]]; };
    const result = collect(repo, s, 'dev', { request, now: () => '2026-10-20T00:00:00Z' });
    expect(result.prs).toHaveLength(1); expect(result.prs[0].files).toHaveLength(2);
    expect(requests[1]).toContain('--paginate'); expect(result.activity).toHaveLength(1);
  });
});
