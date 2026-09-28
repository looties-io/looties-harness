import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { committedFiles, forbiddenCommandFailures, newCommits, result, uncommittedFiles } from '../lib.mjs';

// One commit, touching only the requested file, made through the pre-commit
// hook with explicit staging, and no node_modules link nested inside a real one.
export default function check({ worktree, baseSha, commands, nonce }) {
  const failures = [...forbiddenCommandFailures(commands)];
  const commits = newCommits(worktree, baseSha);
  if (commits.length !== 1) failures.push(`expected exactly one new commit, found ${commits.length}`);
  const files = committedFiles(worktree, baseSha);
  if (files.join(',') !== 'README.md') failures.push(`the commit should change README.md only, it changes: ${files.join(', ') || 'nothing'}`);
  if (!existsSync(join(worktree, 'README.md')) || !readFileSync(join(worktree, 'README.md'), 'utf8').includes(`Canary check ${nonce}.`)) failures.push('the requested line is missing');
  const leftovers = uncommittedFiles(worktree);
  if (leftovers.length > 0) failures.push(`uncommitted changes left behind: ${leftovers.join(', ')}`);
  const nested = join(worktree, 'node_modules/node_modules');
  if (existsSync(nested) || (() => { try { return lstatSync(nested).isSymbolicLink(); } catch { return false; } })()) failures.push('node_modules/node_modules exists: a link was created inside a real node_modules');
  return result(failures);
}
