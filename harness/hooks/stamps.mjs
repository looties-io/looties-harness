import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The approval store behind an L0 merge or direct push to the integration
// branch (docs/agent-harness.md#direct-push-to-the-integration-branch): the verdict an
// independent reviewer subagent ended on, per commit. It lives in the
// worktree's own git directory, so it is never committed. Only the
// review-stamp hook writes it; the guard denies agents any write there.

export const STAMP_DIRECTORY = 'agent-review-stamps';
export const VERDICT_LINE = /^\s*Independent review:\s*(APPROVE|REQUEST_CHANGES)\s+([0-9a-f]{40})\b/m;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** The stamp directory of the worktree that contains `cwd`. */
export function stampRoot(cwd) {
  const gitDirectory = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return join(gitDirectory, STAMP_DIRECTORY);
}

function stampPath(root, kind, sha) {
  if (!FULL_SHA.test(sha ?? '')) throw new Error(`not a full commit sha: ${sha}`);
  return join(root, kind, `${sha}.json`);
}

function write(root, kind, record) {
  const path = stampPath(root, kind, record.sha);
  mkdirSync(join(root, kind), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}

function read(root, kind, sha) {
  try {
    const record = JSON.parse(readFileSync(stampPath(root, kind, sha), 'utf8'));
    return record?.sha === sha ? record : null;
  } catch {
    return null;
  }
}

/** { sha, verdict: 'APPROVE' | 'REQUEST_CHANGES', agentId, sessionId, at }. The latest verdict for a commit wins. */
export const recordReview = (root, record) => write(root, 'reviews', record);
export const readReview = (root, sha) => read(root, 'reviews', sha);
