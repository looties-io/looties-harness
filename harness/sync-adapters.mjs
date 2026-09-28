#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManifest } from './check.mjs';
import { GUARDED_COMMANDS, loadConfig, productionCommandNames } from './hooks/config.mjs';

// Generates the per-tool agent adapters (.claude/, .codex/) from the single
// source in .agents/, following .agents/manifest.json. The layout and the
// rules are owned by docs/agent-harness.md#sources-and-adapters.
//
//   node .agents/sync-adapters.mjs          write the adapters
//   node .agents/sync-adapters.mjs --check  report drift, exit 1 on any
//
// Hook entries pin the shape of manifest `options`:
//   { "claude": [HookSpec], "codex": [HookSpec] }   (either key optional)
//   HookSpec = { event, matcher?, timeout?, ...extra handler fields }
// The generator builds each hook command from the entry's source path.

export const STATE_PATH = '.agents/manifest.state.json';
export const CLAUDE_SETTINGS = '.claude/settings.json';
export const CODEX_HOOKS = '.codex/hooks.json';
export const CODEX_CONFIG = '.codex/config.toml';
// Directories whose every entry is generated; anything else in them is stale.
// `.claude/skills` is owned only while `.agents/skills` exists: a repository
// without shared skills keeps whatever its own `.claude/skills` holds.
export const OWNED_DIRECTORIES = ['.claude/rules', '.claude/agents', '.claude/skills', '.codex/agents'];
const SKILLS_SOURCE = '.agents/skills';
const RUN = 'node .agents/sync-adapters.mjs';

const READ_ONLY_CLAUDE_TOOLS = 'Read, Grep, Glob, Bash, WebFetch, WebSearch';
// A missing hook script fails closed for the enforcement hook (PreToolUse):
// the tool call is refused with a message saying how to restore it. The
// context hooks (anchor, healing, review stamp, stop) stay fail-open, since
// without them a session loses context, not a protection. Codex reads
// .codex/hooks.json from the main checkout but runs the command in the
// current worktree, which may predate the harness or not carry it at all:
// there a missing script passes, unless that checkout's manifest declares it.
const MISSING_GUARD = (source) => `The agent guard ${source} is missing from this checkout, so every tool call is refused. Restore it outside the agent (in Claude Code: ! git restore ${source}), then retry.`;
const denyJson = (source) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: MISSING_GUARD(source) } });
const runner = (source, tool) => `${source.endsWith('.sh') ? 'bash' : 'node'} "$f"${source.endsWith('.sh') ? '' : ` --tool ${tool}`}`;
const HOOK_COMMAND = {
  claude: (source, event) => (event === 'PreToolUse'
    ? `f="$CLAUDE_PROJECT_DIR/${source}"; [ -f "$f" ] || { printf '%s\\n' '${denyJson(source)}'; exit 0; }; ${runner(source, 'claude')}`
    : `${source.endsWith('.sh') ? 'bash' : 'node'} "$CLAUDE_PROJECT_DIR/${source}"${source.endsWith('.sh') ? '' : ' --tool claude'}`),
  codex: (source, event) => (event === 'PreToolUse'
    ? `r="$(git rev-parse --show-toplevel)"; f="$r/${source}"; if [ ! -f "$f" ]; then grep -qF '"${source}"' "$r/.agents/manifest.json" 2>/dev/null || exit 0; printf '%s\\n' '${denyJson(source)}'; exit 0; fi; ${runner(source, 'codex')}`
    : `f="$(git rev-parse --show-toplevel)/${source}"; [ -f "$f" ] || exit 0; ${runner(source, 'codex')}`),
};
const LINK = /\]\((?!https?:|mailto:|#|\/)([^)\s#]+)(#[^)\s]*)?\)/g;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function readJson(root, path) {
  return JSON.parse(readFileSync(join(root, path), 'utf8'));
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].replace(/^["']|["']$/g, '');
  }
  return { fields, body: text.slice(match[0].length) };
}

function tomlString(value) {
  return JSON.stringify(value);
}

function tomlMultiline(value) {
  if (!value.includes("'''")) return `'''\n${value}'''`;
  return tomlString(value);
}

// A generated role file sits elsewhere than its source, so each relative link
// is rewritten to point at the same file from the target, or, for a TOML
// string that has no location, as a repository-root path.
function rewriteLinks(text, source, target = null) {
  return text.replace(LINK, (whole, link, anchor = '') => {
    const fromRoot = posix.normalize(posix.join(posix.dirname(source), link));
    return `](${target ? posix.relative(posix.dirname(target), fromRoot) : fromRoot}${anchor})`;
  });
}

function claudeAgent(text, source, target) {
  const { fields, body: raw } = frontmatter(text);
  const body = rewriteLinks(raw, source, target);
  const lines = ['---', `name: ${fields.name}`, `description: ${fields.description}`];
  if (fields.access === 'read-only') lines.push(`tools: ${READ_ONLY_CLAUDE_TOOLS}`);
  lines.push('---', '', '');
  return `${lines.join('\n')}${body.replace(/^\n+/, '')}`;
}

function codexAgent(text, source) {
  const { fields, body: raw } = frontmatter(text);
  const body = rewriteLinks(raw, source);
  return [
    `# Generated by .agents/sync-adapters.mjs from ${source}. Edit the source, then run ${RUN}.`,
    `name = ${tomlString(fields.name)}`,
    `description = ${tomlString(fields.description)}`,
    `sandbox_mode = ${tomlString(fields.access === 'read-only' ? 'read-only' : 'workspace-write')}`,
    `developer_instructions = ${tomlMultiline(body.replace(/^\n+/, ''))}`,
    '',
  ].join('\n');
}

function codexConfig() {
  return [
    `# Generated by .agents/sync-adapters.mjs from .agents/. Edit the source, then run ${RUN}.`,
    '# Project settings Codex applies once this folder is trusted; roles load from .codex/agents/.',
    'sandbox_mode = "workspace-write"',
    'approval_policy = "on-request"',
    '',
  ].join('\n');
}

function skillNames(root, source) {
  const absolute = join(root, source);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(absolute, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

function addHook(groups, spec, command) {
  const { event, matcher, timeout, ...extra } = spec;
  const handler = { type: 'command', command, ...(timeout ? { timeout } : {}), ...extra };
  groups[event] ??= [];
  groups[event].push({ ...(matcher ? { matcher } : {}), hooks: [handler] });
}

/**
 * Computes every adapter from the manifest. Returns files (path -> content),
 * links (path -> symlink target) and problems found in the sources.
 */
export function generate(root = '.') {
  const manifest = readJson(root, '.agents/manifest.json');
  const files = new Map();
  const links = new Map();
  const problems = [...checkManifest(root)];
  const hooks = { claude: {}, codex: {} };
  const state = { version: manifest.version, entries: {} };
  const claimed = new Map();

  for (const entry of Array.isArray(manifest.entries) ? manifest.entries : []) {
    const entryProblems = entryShapeProblems(root, entry, claimed);
    if (entryProblems.length > 0) {
      problems.push(...entryProblems);
      continue;
    }
    const sourcePath = join(root, entry.source);
    const isDirectory = entry.kind === 'skill';
    const source = isDirectory ? '' : readFileSync(sourcePath, 'utf8');
    const outputs = {};
    if (entry.kind === 'hook') {
      for (const tool of ['claude', 'codex']) {
        const specs = entry.options?.[tool];
        if (!entry.targets[tool]) continue;
        if (!Array.isArray(specs) || specs.some((spec) => typeof spec?.event !== 'string')) {
          problems.push(`.agents/manifest.json: hook ${entry.id} needs options.${tool} as a list of { event, matcher?, timeout? }`);
          continue;
        }
        for (const spec of specs) addHook(hooks[tool], spec, HOOK_COMMAND[tool](entry.source, spec.event));
      }
    } else if (entry.kind === 'skill') {
      const names = skillNames(root, entry.source);
      if (entry.targets.claude) {
        for (const name of names) links.set(`${entry.targets.claude}/${name}`, relative(join(root, entry.targets.claude), join(root, entry.source, name)));
        outputs.claude = sha256(JSON.stringify(names));
      }
    } else {
      if (entry.targets.claude) {
        const content = entry.kind === 'agent' ? claudeAgent(source, entry.source, entry.targets.claude) : source;
        files.set(entry.targets.claude, content);
        outputs.claude = sha256(content);
      }
      if (entry.targets.codex) {
        const content = entry.kind === 'agent' ? codexAgent(source, entry.source) : source;
        files.set(entry.targets.codex, content);
        outputs.codex = sha256(content);
      }
    }
    state.entries[entry.id] = { source: isDirectory ? sha256(JSON.stringify(skillNames(root, entry.source))) : sha256(source), targets: outputs };
  }

  const settingsPath = join(root, CLAUDE_SETTINGS);
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const { hooks: _previous, ...handMaintained } = settings;
  files.set(CLAUDE_SETTINGS, `${JSON.stringify({ ...handMaintained, hooks: hooks.claude }, null, 2)}\n`);
  files.set(CODEX_HOOKS, `${JSON.stringify({ hooks: hooks.codex }, null, 2)}\n`);
  files.set(CODEX_CONFIG, codexConfig());
  // Only the generated hooks are hashed, so editing the hand-maintained
  // permissions never shows up as drift.
  const hookHashes = { claude: sha256(JSON.stringify(hooks.claude)), codex: sha256(JSON.stringify(hooks.codex)) };
  for (const entry of manifest.entries.filter((candidate) => candidate?.kind === 'hook' && state.entries[candidate.id])) {
    state.entries[entry.id].targets = hookHashes;
  }

  problems.push(...permissionProblems(handMaintained.permissions, productionCommandNames(loadConfig(root))), ...instinctProblems(root, manifest));
  files.set(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  return { files, links, problems };
}

// What the generator itself needs from an entry before it can write anything:
// a readable source of the right type and targets that stay inside their
// adapter folder and belong to no other entry. Hook entries share the settings
// files they merge into.
function entryShapeProblems(root, entry, claimed) {
  const label = `.agents/manifest.json: entry ${entry?.id ?? '?'}`;
  // Shared skills are optional: a missing skills directory generates no link.
  const optional = entry?.kind === 'skill' && entry.source === SKILLS_SOURCE;
  if (typeof entry?.source !== 'string' || (!optional && !existsSync(join(root, entry.source)))) return [`${label}: source ${entry?.source} is missing`];
  if (!['rule', 'level', 'agent', 'hook', 'instinct', 'skill'].includes(entry.kind)) return [`${label}: unknown kind ${entry.kind}, nothing generated`];
  const isDirectory = existsSync(join(root, entry.source)) ? lstatSync(join(root, entry.source)).isDirectory() : optional;
  if (isDirectory !== (entry.kind === 'skill')) return [`${label}: a ${entry.kind} source must be ${entry.kind === 'skill' ? 'a directory' : 'a file'}`];
  const problems = [];
  for (const [tool, prefix] of [['claude', '.claude/'], ['codex', '.codex/']]) {
    const target = entry.targets?.[tool];
    if (target === null || target === undefined) continue;
    if (typeof target !== 'string' || !posix.normalize(target).startsWith(prefix) || target.split('/').includes('..')) {
      problems.push(`${label}: ${tool} target ${target} must stay under ${prefix}`);
      continue;
    }
    if (entry.kind === 'hook') continue;
    if (claimed.has(target)) problems.push(`${label}: ${tool} target ${target} is already generated by ${claimed.get(target)}`);
    else claimed.set(target, entry.id);
  }
  return problems;
}

// An allow rule that covers a production or guarded command would let it run
// unasked, and every production command needs its own ask rule as a second
// layer behind the guard. The production commands come from
// .agents/harness.config.json (docs/agent-harness.md#configuration).
export function permissionProblems(permissions = {}, productionCommands = []) {
  const problems = [];
  const neverAllowed = [...productionCommands, ...GUARDED_COMMANDS];
  for (const rule of permissions.allow ?? []) {
    const match = /^Bash(?:\((.*)\))?$/.exec(rule);
    if (!match) continue;
    const prefix = (match[1] ?? '').replace(/:?\*$/, '').trim();
    const covered = neverAllowed.filter((command) => command.startsWith(prefix) || prefix.startsWith(command));
    if (covered.length > 0) problems.push(`${CLAUDE_SETTINGS}: allow rule ${rule} covers ${covered.join(', ')}, which must ask every time (docs/agent-harness.md#production-confirmations)`);
  }
  const asks = new Set(permissions.ask ?? []);
  for (const command of productionCommands) {
    if (!asks.has(`Bash(${command}:*)`)) problems.push(`${CLAUDE_SETTINGS}: permissions.ask needs Bash(${command}:*), a production command (docs/agent-harness.md#production-confirmations)`);
  }
  return problems;
}

// Every instinct file needs a manifest entry, or the anchor never loads it.
function instinctProblems(root, manifest) {
  const directory = join(root, '.agents/instincts');
  if (!existsSync(directory)) return [];
  const sources = new Set(manifest.entries.filter((entry) => entry.kind === 'instinct').map((entry) => entry.source));
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => `.agents/instincts/${name}`)
    .filter((path) => !sources.has(path))
    .map((path) => `.agents/manifest.json: ${path} has no instinct entry, so the anchor hook never loads it`);
}

export function ownedDirectories(root) {
  return OWNED_DIRECTORIES.filter((directory) => directory !== '.claude/skills' || existsSync(join(root, SKILLS_SOURCE)));
}

function listOwned(root) {
  return ownedDirectories(root).flatMap((directory) => {
    const absolute = join(root, directory);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute).map((name) => `${directory}/${name}`);
  });
}

function linkTarget(root, path) {
  try {
    return lstatSync(join(root, path)).isSymbolicLink() ? readlinkSync(join(root, path)) : null;
  } catch {
    return null;
  }
}

/** Returns one message per difference between the adapters on disk and the generated ones. */
export function check(root = '.') {
  const { files, links, problems } = generate(root);
  const drift = [...problems];
  for (const [path, content] of files) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) drift.push(`${path}: missing`);
    else if (readFileSync(absolute, 'utf8') !== content) drift.push(`${path}: differs from its source`);
  }
  for (const [path, target] of links) {
    const actual = linkTarget(root, path);
    if (actual === null) drift.push(`${path}: must be a symlink to ${target}`);
    else if (actual !== target) drift.push(`${path}: links to ${actual}, expected ${target}`);
  }
  for (const path of listOwned(root)) {
    if (!files.has(path) && !links.has(path)) drift.push(`${path}: not generated from any manifest entry`);
  }
  return drift;
}

/** Writes every adapter and removes stale generated entries, unless the sources have problems. Returns them. */
export function write(root = '.') {
  const { files, links, problems } = generate(root);
  // A broken manifest could delete or overwrite adapters; write nothing.
  if (problems.length > 0) return problems;
  for (const path of listOwned(root)) {
    if (!files.has(path) && !links.has(path)) rmSync(join(root, path), { recursive: true, force: true });
  }
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    if (!existsSync(join(root, path)) || readFileSync(join(root, path), 'utf8') !== content) writeFileSync(join(root, path), content);
  }
  for (const [path, target] of links) {
    if (linkTarget(root, path) === target) continue;
    rmSync(join(root, path), { recursive: true, force: true });
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  }
  return problems;
}

// Both sides resolved: a symlinked path to this script must still run the
// check, never skip it and exit 0.
function isEntrypoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--check')) {
    const drift = check(root);
    if (drift.length > 0) {
      console.error(`Agent adapters are out of date (${drift.length}):\n${drift.map((line) => `- ${line}`).join('\n')}\nEdit the source under .agents/, then run ${RUN}.`);
      process.exit(1);
    }
    console.log('Agent adapters match .agents/.');
  } else {
    const problems = write(root);
    if (problems.length > 0) {
      console.error(problems.map((line) => `- ${line}`).join('\n'));
      process.exit(1);
    }
    console.log('Agent adapters written from .agents/.');
  }
}
