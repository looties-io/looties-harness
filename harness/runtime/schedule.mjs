#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, options } from './store.mjs';
import { main as hardening } from './hardening.mjs';

// Orca owns the timer and agent launch. This command only gates a reviewed deployment and reserves work.
export function main(args = process.argv.slice(2)) {
  const o = options(args, ['repo', 'ref', 'state-root']); const repo = resolve(o.repo || process.cwd()); const ref = o.ref;
  if (!/^origin\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref ?? '')) throw new Error('Name the integration ref as origin/BRANCH');
  execFileSync('git', ['fetch', '--quiet', 'origin', ref.slice(7)], { cwd: repo, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  const source = dirname(fileURLToPath(import.meta.url));
  for (const file of ['store.mjs', 'mission.mjs', 'hardening.mjs', 'schedule.mjs']) {
    let deployed;
    try { deployed = git(repo, ['show', `${ref}:.agents/runtime/${file}`]); }
    catch { console.log(`V2 not deployed on ${ref}; no campaign dispatched`); return 3; }
    if (deployed !== readFileSync(join(source, file), 'utf8').trim()) throw new Error(`Reviewed runtime differs from ${ref}: ${file}; update the scheduler source through normal review`);
  }
  return hardening(['precheck', '--repo', repo, '--ref', ref, ...(o['state-root'] ? ['--state-root', o['state-root']] : [])]);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(`Hardening scheduler failed: ${error.message}`); process.exitCode = 2; }
}
