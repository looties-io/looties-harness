import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The one place a repository adapts the harness: `.agents/harness.config.json`,
// merged over the defaults below. Everything else under `.agents/` is the
// same in every repository. The config file is itself a harness file: the
// guard asks before any edit of it, because a looser config is a weaker guard.
// Owned by docs/agent-harness.md#configuration.

export const CONFIG_FILE = '.agents/harness.config.json';

export const DEFAULT_CONFIG = Object.freeze({
  // The branch agents integrate into (reviewed L0 merges and direct pushes
  // land here) and the branch that deploys production (no agent pushes to it;
  // a merge into it is a production confirmation).
  branches: Object.freeze({ integration: 'dev', release: 'main' }),
  // The workflow a direct push to the integration branch must have run green
  // through workflow_dispatch on a feature branch at the pushed commit.
  ci: Object.freeze({ workflow: 'ci.yml' }),
  // Commands that ask the maintainer every time, at every level. `command` is
  // matched on words: the first is the program, each later word must follow in
  // order, and a word starting with `-` may appear anywhere.
  productionCommands: Object.freeze([]),
  // Lint, test and build configuration, as regular expressions on the path
  // relative to the repository root. Editing one asks the maintainer.
  protectedConfig: Object.freeze([
    '^eslint\\.config\\.[cm]?[jt]s$',
    '^\\.eslintrc(?:\\.\\w+)?$',
    '^vite\\.config\\.[cm]?[jt]s$',
    '^vitest\\.(?:config|workspace)\\.[cm]?[jt]s$',
    '^jest\\.config\\.[cm]?[jt]s$',
    '^tsconfig[^/]*\\.json$',
    '^playwright\\.config\\.[cm]?[jt]s$',
    '^knip\\.jsonc?$',
  ]),
  // A documentation-only direct push runs this check on the pushed commit
  // instead of a CI run: an argv array whose exit 0 means no finding and 1
  // means findings listed on stderr as `- <path>: <finding>`. null: no check.
  docsCheck: null,
  // Where the self-healing loop writes its dated decision records.
  recordsDirectory: 'docs/records',
  // The private repository the agent journal syncs to (`owner/name`). null:
  // the journal stays local.
  journalRepository: null,
  // Labels of issues your own robots open (monitors, audits, alerting): the
  // loop counts them as failure signals.
  signalLabels: Object.freeze([]),
  // Paths the loop never touches, on top of the harness's own list.
  neverTouch: Object.freeze([]),
});

const cache = new Map();

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key.startsWith('$')) continue;
    const current = base[key];
    result[key] = current && typeof current === 'object' && !Array.isArray(current) && value && typeof value === 'object' && !Array.isArray(value) ? { ...current, ...value } : value;
  }
  return result;
}

/**
 * The effective config of the repository at `root`. A missing file gives the
 * defaults; an unreadable or invalid one throws, so the guard fails closed
 * (its fallback asks) rather than running with a config it did not read.
 */
export function loadConfig(root) {
  if (cache.has(root)) return cache.get(root);
  let raw = null;
  try {
    raw = readFileSync(join(root, CONFIG_FILE), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const merged = raw === null ? DEFAULT_CONFIG : merge(DEFAULT_CONFIG, JSON.parse(raw));
  // A bare string is accepted as a production command with a generic effect,
  // so the guard, the ask rules and the drift check all read one shape.
  const config = { ...merged, productionCommands: (merged.productionCommands ?? []).map(normalizeProductionCommand) };
  cache.set(root, config);
  return config;
}

function normalizeProductionCommand(entry) {
  if (typeof entry === 'string' && entry.trim()) return { command: entry.trim(), effect: 'a production change' };
  if (entry && typeof entry.command === 'string' && entry.command.trim()) return { command: entry.command.trim(), effect: typeof entry.effect === 'string' && entry.effect ? entry.effect : 'a production change' };
  throw new Error(`productionCommands entries need a command: ${JSON.stringify(entry)}`);
}

/** The production commands as plain strings, for the settings `ask` rules. */
export const productionCommandNames = (config) => config.productionCommands.map((entry) => entry.command);

// Commands no allow rule may cover although they do not always ask: the guard
// decides (an L0 merge into the integration branch).
export const GUARDED_COMMANDS = Object.freeze(['gh pr merge']);

// The loop's own runs draw their powers from these variables; only the
// nightly pass and the canary runner set them, as processes outside any agent
// session.
export const LOOP_ENV = Object.freeze({ nightly: 'HARNESS_NIGHTLY', healing: 'HARNESS_HEALING', canary: 'HARNESS_CANARY' });
