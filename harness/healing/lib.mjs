import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../hooks/config.mjs';

// Shared constants and plumbing of the self-healing loop. The loop and its
// limits are owned by docs/agent-harness.md#self-healing-loop; the journal it
// reads and writes lives in .agents/hooks/journal.mjs.

// .agents/healing/ once installed: the repository is two levels up.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const LIMITS = Object.freeze({
  activeRules: 40,
  ruleBodyLines: 5,
  ruleBodyBytes: 400,
  learnedTotalBytes: 6144,
  reviewMaxDays: 90,
  duplicateSimilarity: 0.6,
  candidatesPerNight: 3,
  // Design decision 23: a protection may be proposed for loosening once it blocked
  // legitimate work this many times within the window, with no real catch.
  frictionEvents: 3,
  frictionWindowDays: 30,
});

export const LEARNED_DIRECTORY = '.agents/rules/learned';
export const EVALS_DIRECTORY = '.agents/evals';
export const ISSUE_LABELS = Object.freeze({
  base: 'self-healing',
  human: 'needs-human',
  rule: 'self-healing:rule',
  skill: 'self-healing:skill',
  loosening: 'self-healing:loosening',
  retire: 'self-healing:retire',
  applied: 'self-healing:applied',
});
export const CANDIDATE_TYPES = Object.freeze(['rule', 'skill', 'loosening']);

// Paths the loop never changes (design decision 23), as prefixes or exact
// repository paths: the harness itself, the authorities it answers to, CI,
// and the lint, test and build configuration. A candidate may not target
// them; a rule may not tell an agent to edit them. A repository adds its own
// through `neverTouch` in the config (see neverTouchPaths).
export const NEVER_TOUCH = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  'docs/agent-harness.md',
  'docs/design-decisions.md',
  '.agents/hooks/',
  '.agents/manifest',
  '.agents/harness.config.json',
  '.agents/evals/',
  '.agents/healing/',
  '.agents/sync-adapters.mjs',
  '.agents/check.mjs',
  '.claude/settings',
  '.codex/',
  '.github/workflows/',
  '.git/hooks',
  'package.json',
  'eslint.config',
  '.eslintrc',
  'vite.config',
  'vitest.config',
  'vitest.workspace',
  'jest.config',
  'tsconfig',
  'playwright.config',
  'knip.json',
]);

/** The harness's never-touch paths plus the repository's own (`neverTouch` in the config). */
export function neverTouchPaths(root = repoRoot) {
  const extra = loadConfig(root).neverTouch;
  return Object.freeze([...NEVER_TOUCH, ...(Array.isArray(extra) ? extra.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()) : [])]);
}

/** The repository's effective harness config (branches, records directory, labels). */
export const harnessConfig = (root = repoRoot) => loadConfig(root);

export function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/** ISO 8601 week of `date`, as 2026-W40. */
export function isoWeek(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  return `${day.getUTCFullYear()}-W${String(Math.ceil(((day - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 3600 * 1000);
}

/** Splits `---` frontmatter of simple `key: value` and `key:` + `  - item` lists. */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: null, body: text };
  const data = {};
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      data[listKey].push(unquote(item[1]));
      continue;
    }
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    listKey = null;
    if (pair[2] === '') {
      data[pair[1]] = [];
      listKey = pair[1];
    } else data[pair[1]] = unquote(pair[2]);
  }
  return { data, body: text.slice(match[0].length) };
}

function unquote(value) {
  return value.trim().replace(/^(["'])(.*)\1$/, '$2');
}

export function run(command, args, { cwd = repoRoot, input, timeout = 120_000, env } = {}) {
  return execFileSync(command, args, { cwd, input, timeout, env: env ?? process.env, encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

export function gh(args, options) {
  return run('gh', args, options);
}

export function slug(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'rule';
}
