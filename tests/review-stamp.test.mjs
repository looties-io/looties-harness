// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reviewRecord } from '../harness/hooks/review-stamp.mjs';
import { STAMP_DIRECTORY, readReview, recordReview, stampRoot } from '../harness/hooks/stamps.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
// Inside a git hook, git exports GIT_DIR and GIT_INDEX_FILE. Inherited, they
// make `git init` in a fixture reinitialise the real repository as bare and
// send the stamps under test into the real approval store.
for (const name of execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split('\n')) delete process.env[name];
const payload = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'agent-hooks', 'claude-subagent-stop.json'), 'utf8'));
const SHA = '6faf046df3200f4434ebb71eabc2b3bd653ecdb8';
const NOW = new Date('2026-09-27T12:00:00Z');
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-review-stamp-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

describe('review-stamp hook', () => {
  it('turns the captured reviewer SubagentStop payload into a review record', () => {
    expect(reviewRecord(payload, NOW)).toEqual({ sha: SHA, verdict: 'APPROVE', agentId: 'aa8f18a2f47e8af39', sessionId: '00000000-0000-4000-8000-000000000002', at: '2026-09-27T12:00:00.000Z' });
  });

  it('records nothing for another role, another event, or no verdict line', () => {
    expect(reviewRecord({ ...payload, agent_type: 'implementer' })).toBeNull();
    expect(reviewRecord({ ...payload, agent_type: undefined })).toBeNull();
    expect(reviewRecord({ ...payload, hook_event_name: 'Stop' })).toBeNull();
    expect(reviewRecord({ ...payload, last_assistant_message: 'Looks good to me.' })).toBeNull();
    expect(reviewRecord({ ...payload, last_assistant_message: 'Independent review: APPROVE <sha>' })).toBeNull();
  });

  it('records the last verdict line, not an earlier one it quotes', () => {
    const text = `The previous round said:\nIndependent review: APPROVE ${SHA}\nThat no longer holds.\n\nIndependent review: REQUEST_CHANGES ${SHA}\nReviewer session: s2`;
    expect(reviewRecord({ ...payload, last_assistant_message: text }, NOW).verdict).toBe('REQUEST_CHANGES');
  });

  it('records REQUEST_CHANGES too, so a later verdict replaces an earlier approval', () => {
    const root = path.join(repository(), '.git', STAMP_DIRECTORY);
    recordReview(root, reviewRecord(payload, NOW));
    recordReview(root, reviewRecord({ ...payload, last_assistant_message: `Independent review: REQUEST_CHANGES ${SHA}` }, NOW));
    expect(readReview(root, SHA).verdict).toBe('REQUEST_CHANGES');
    expect(readReview(root, 'b'.repeat(40))).toBeNull();
    expect(() => recordReview(root, { sha: '../../evil', verdict: 'APPROVE' })).toThrow(/full commit sha/);
  });

  it('writes into the worktree git directory through the CLI, where the guard reads it', () => {
    const root = repository();
    execFileSync('node', [path.join(repoRoot, 'harness/hooks/review-stamp.mjs'), '--tool', 'claude'], { input: JSON.stringify({ ...payload, cwd: root }), encoding: 'utf8' });
    expect(stampRoot(root)).toBe(path.join(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: root, encoding: 'utf8' }).trim(), STAMP_DIRECTORY));
    expect(readReview(stampRoot(root), SHA)).toMatchObject({ sha: SHA, verdict: 'APPROVE' });
  });
});
