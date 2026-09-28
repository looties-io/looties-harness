#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOOP_ENV } from '../hooks/config.mjs';
import { writeDocument } from '../hooks/journal.mjs';
import { loadCandidate } from './candidate.mjs';
import { EVALS_DIRECTORY, harnessConfig, repoRoot, run } from './lib.mjs';
import { learnedRuleFiles } from './lint.mjs';

// Canary replay: every candidate rule runs the protected cases of
// .agents/evals/ before the maintainer sees it, because most rejected rules in
// the self-healing paper fixed their own failure and broke a case that
// worked. Each case runs Claude Code headless on the maintainer's
// subscription, in a fresh worktree of the base ref (origin/<integration
// branch> by default) that is removed afterwards; pushes and GitHub are made
// unreachable through the environment. Usage:
//   node .agents/healing/canary.mjs run [--candidate <id>] [--case <id>] [--skill <name>] [--ref <git ref>]
// Owned by docs/agent-harness.md#self-healing-loop.

// Environment that keeps a canary on the machine, on top of the guard hook:
// git pushes go to a path that does not exist, and GitHub rejects the token.
// Add your own provider's token variables here when a case could reach it.
export const CANARY_ENV = Object.freeze({
  [LOOP_ENV.canary]: '1',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
  GIT_CONFIG_VALUE_0: '/nonexistent/a-canary-never-pushes',
  GH_TOKEN: 'a-canary-has-no-github-access',
  GITHUB_TOKEN: 'a-canary-has-no-github-access',
});

/** The default base of a canary: the integration branch on origin. */
export const defaultRef = (root = repoRoot) => `origin/${harnessConfig(root).branches.integration}`;

/**
 * The core cases, or those of one skill (.agents/evals/skills/<skill>/<case>/).
 * A directory whose name starts with `_` (the `_template`) is not a case.
 */
export function loadCases(root = repoRoot, { skill = null } = {}) {
  const base = skill ? path.join(root, EVALS_DIRECTORY, 'skills', skill) : path.join(root, EVALS_DIRECTORY);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'skills' && !entry.name.startsWith('_') && existsSync(path.join(base, entry.name, 'case.json')))
    .map((entry) => ({ ...JSON.parse(readFileSync(path.join(base, entry.name, 'case.json'), 'utf8')), directory: path.join(base, entry.name) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Bash commands, other tool calls and the final answer from `claude -p --output-format stream-json`. */
export function parseStream(text) {
  const commands = [];
  const toolCalls = [];
  let finalText = '';
  for (const line of String(text).split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant') {
      for (const part of event.message?.content ?? []) {
        if (part?.type !== 'tool_use') continue;
        toolCalls.push({ name: part.name, input: part.input });
        if (part.name === 'Bash' && typeof part.input?.command === 'string') commands.push(part.input.command);
      }
    }
    if (event.type === 'result' && typeof event.result === 'string') finalText = event.result;
  }
  return { commands, toolCalls, finalText };
}

/** The system-prompt addition a canary runs with: the admitted rules plus the candidate. */
export function rulesPrompt(root, candidate) {
  const rules = learnedRuleFiles(root).map((rule) => `- ${rule.name}: ${rule.body.replace(/\n+/g, ' ')}`);
  if (candidate?.type === 'rule') rules.push(`- ${candidate.id}: ${candidate.body.replace(/\n+/g, ' ')}`);
  return rules.length === 0 ? '' : `## Learned rules\nAdmitted by the maintainer through the self-healing loop; each tightens a rule above, never loosens it.\n${rules.join('\n')}`;
}

export async function runCase(caseDefinition, { root = repoRoot, ref = defaultRef(root), rules = '', claude = process.env.HARNESS_CLAUDE_BIN || 'claude' } = {}) {
  const nonce = randomBytes(4).toString('hex');
  const worktree = mkdtempSync(path.join(tmpdir(), `harness-canary-${caseDefinition.id}-`));
  const branch = `canary/${caseDefinition.id}-${nonce}`;
  const started = Date.now();
  run('git', ['worktree', 'add', '-q', '-b', branch, worktree, ref], { cwd: root });
  try {
    const baseSha = run('git', ['rev-parse', 'HEAD'], { cwd: worktree }).trim();
    if (caseDefinition.setup?.linkNodeModules) symlinkSync(realpathSync(path.join(root, 'node_modules')), path.join(worktree, 'node_modules'));
    const before = { branches: run('git', ['branch', '--list'], { cwd: worktree }).trim() };
    const env = { ...process.env, ...CANARY_ENV };
    delete env[LOOP_ENV.healing];
    delete env[LOOP_ENV.nightly];
    const args = ['-p', caseDefinition.prompt.replaceAll('{nonce}', nonce), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--max-turns', String(caseDefinition.maxTurns ?? 40)];
    if (rules) args.push('--append-system-prompt', rules);
    const session = spawnSync(claude, args, { cwd: worktree, env, encoding: 'utf8', timeout: (caseDefinition.timeoutMinutes ?? 15) * 60_000, maxBuffer: 256 * 1024 * 1024 });
    const { commands, finalText } = parseStream(session.stdout ?? '');
    const check = (await import(pathToFileURL(path.join(caseDefinition.directory, 'check.mjs')).href)).default;
    const verdict = session.error?.code === 'ETIMEDOUT'
      ? { pass: false, failures: [`timed out after ${caseDefinition.timeoutMinutes ?? 15} minutes`] }
      : await check({ worktree, baseSha, commands, finalText, nonce, before });
    return { case: caseDefinition.id, pass: verdict.pass, failures: verdict.failures, exitCode: session.status, durationMs: Date.now() - started, commands: commands.slice(0, 60), answer: finalText.slice(0, 1000) };
  } catch (error) {
    return { case: caseDefinition.id, pass: false, failures: [`the canary could not run: ${String(error?.message ?? error).split('\n')[0]}`], infrastructure: true, durationMs: Date.now() - started };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: root });
    spawnSync('git', ['branch', '-D', branch], { cwd: root });
  }
}

/**
 * Runs every case with the candidate. A failing case runs again with it and
 * once without it: the candidate is blamed only when it fails twice and the
 * baseline passes; anything else is inconclusive and blocks the admission.
 */
export async function runCanaries({ candidate = null, cases, root = repoRoot, ref = defaultRef(root), runner = runCase }) {
  const withRule = rulesPrompt(root, candidate);
  const baseline = rulesPrompt(root, null);
  const results = [];
  for (const caseDefinition of cases) {
    const first = await runner(caseDefinition, { root, ref, rules: withRule });
    if (first.pass) {
      results.push({ case: caseDefinition.id, outcome: 'pass', runs: [first] });
      continue;
    }
    const again = await runner(caseDefinition, { root, ref, rules: withRule });
    const without = await runner(caseDefinition, { root, ref, rules: baseline });
    const outcome = !again.pass && without.pass && candidate ? 'broken-by-candidate' : (again.pass ? 'flaky' : 'failing-without-candidate');
    results.push({ case: caseDefinition.id, outcome, runs: [first, again, without] });
  }
  const verdict = results.every((entry) => entry.outcome === 'pass') ? 'pass' : (results.some((entry) => entry.outcome === 'broken-by-candidate') ? 'fail' : 'inconclusive');
  return { verdict, ref, candidate: candidate?.id ?? null, results };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'run') {
    console.error('usage: canary.mjs run [--candidate <id>] [--case <id>] [--skill <name>] [--ref <git ref>]');
    process.exit(2);
  }
  const candidate = option('--candidate') ? loadCandidate(option('--candidate')) : null;
  if (option('--candidate') && !candidate) {
    console.error(`no candidate ${option('--candidate')} in the agent journal`);
    process.exit(2);
  }
  const integration = harnessConfig(repoRoot).branches.integration;
  const ref = option('--ref') ?? `origin/${integration}`;
  if (ref === `origin/${integration}`) run('git', ['fetch', '--quiet', 'origin', integration]);
  const skill = option('--skill') ?? (candidate?.type === 'skill' ? candidate.skill : null);
  const cases = [...loadCases(repoRoot), ...(skill ? loadCases(repoRoot, { skill }) : [])].filter((entry) => !option('--case') || entry.id === option('--case'));
  const report = await runCanaries({ candidate, cases, ref });
  const at = new Date().toISOString();
  writeDocument(`canaries/${candidate?.id ?? 'baseline'}/${at.replace(/[:.]/g, '-')}.json`, { at, ...report });
  for (const entry of report.results) console.log(`${entry.outcome}\t${entry.case}\t${entry.runs.flatMap((runResult) => runResult.failures ?? []).slice(0, 3).join(' | ')}`);
  console.log(`[canary] ${report.verdict}`);
  process.exit(report.verdict === 'pass' ? 0 : 1);
}
