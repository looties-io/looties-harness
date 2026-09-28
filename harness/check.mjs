#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `.agents/` is the single source of the agent harness. The layout, the size caps
// and the manifest format checked here are owned by
// docs/agent-harness.md#sources-and-adapters; keep the two in step.
//
//   node .agents/check.mjs   report every breach, exit 1 on any

// `skills/` is optional: a repository may have no shared skills.
export const HARNESS_DIRECTORIES = Object.freeze(['skills', 'rules', 'levels', 'agents', 'hooks', 'healing', 'instincts', 'evals', 'schemas']);
export const HARNESS_FILES = Object.freeze(['manifest.json', 'manifest.state.json', 'sync-adapters.mjs', 'check.mjs', 'harness.config.json', 'harness.config.example.json']);
export const MANIFEST_KINDS = Object.freeze(['rule', 'level', 'agent', 'hook', 'instinct', 'skill']);
export const MANIFEST_VERSION = 1;
const TOOL_PREFIXES = Object.freeze({ claude: '.claude/', codex: '.codex/' });

// Line and byte caps for the files loaded on every turn.
export const CAPS = Object.freeze({ base: { lines: 25, bytes: 2048 }, level: { lines: 20 }, rule: { lines: 20 } });

function lineCount(text) {
  return text.replace(/\r?\n$/, '').split(/\r?\n/).length;
}

// Repository-relative Markdown paths under `directory`, recursively.
function markdownUnder(root, directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return markdownUnder(root, path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

// The YAML frontmatter block, only when it opens the file.
function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? match[1] : null;
}

function depth(path) {
  return path.replace(/\/$/, '').split('/').length;
}

/**
 * Checks the `.agents/` harness under `root` and returns one message per breach.
 * Paths in messages are repository-relative.
 */
export function checkAgentHarness(root = '.') {
  const failures = [];
  const read = (path) => readFileSync(join(root, path), 'utf8');

  if (!existsSync(join(root, '.agents'))) return ['.agents: missing agent harness folder'];

  for (const entry of readdirSync(join(root, '.agents'), { withFileTypes: true })) {
    const allowed = entry.isDirectory() ? HARNESS_DIRECTORIES.includes(entry.name) : HARNESS_FILES.includes(entry.name);
    if (!allowed) failures.push(`.agents/${entry.name}: not part of the agent harness layout in docs/agent-harness.md`);
  }

  const checkCap = (path, cap) => {
    const text = read(path);
    const lines = lineCount(text);
    if (lines > cap.lines) failures.push(`${path}: ${lines} lines, over the ${cap.lines}-line cap for always-loaded harness files`);
    const bytes = Buffer.byteLength(text);
    if (cap.bytes && bytes > cap.bytes) failures.push(`${path}: ${bytes} bytes, over the ${cap.bytes}-byte cap`);
  };

  const basePath = '.agents/rules/base.md';
  if (existsSync(join(root, basePath))) checkCap(basePath, CAPS.base);
  else failures.push(`${basePath}: missing base rule`);

  for (const path of markdownUnder(root, '.agents/levels')) checkCap(path, CAPS.level);

  // Every rule is capped, `learned/` included. Only the hand-written top-level
  // rules must be path-scoped pointers; the self-healing loop owns the shape of
  // `learned/` rules.
  for (const path of markdownUnder(root, '.agents/rules').filter((file) => file !== basePath)) {
    checkCap(path, CAPS.rule);
    if (path.startsWith('.agents/rules/learned/')) continue;
    const text = read(path);
    const header = frontmatter(text);
    if (header === null || !/^paths:/m.test(header)) failures.push(`${path}: a path-scoped rule needs \`paths:\` in frontmatter that opens the file`);
    if (!/\]\([^)]*docs\/[^)]+\)/.test(text)) failures.push(`${path}: a path-scoped rule must link to at least one document under docs/`);
  }

  failures.push(...checkManifest(root));
  return failures;
}

// Mirrors .agents/schemas/manifest.schema.json without adding a validator
// dependency. .agents/sync-adapters.mjs runs it before generating.
export function checkManifest(root) {
  const failures = [];
  const manifestPath = '.agents/manifest.json';
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
  } catch (error) {
    return [`${manifestPath}: ${error.message}`];
  }

  if (manifest.version !== MANIFEST_VERSION) failures.push(`${manifestPath}: unsupported version ${manifest.version}; bump MANIFEST_VERSION and the schema together`);
  if (!Array.isArray(manifest.entries)) return [...failures, `${manifestPath}: entries must be an array`];

  const ids = new Set();
  manifest.entries.forEach((entry, index) => {
    const label = `${manifestPath}: entry ${entry?.id ?? index}`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry?.id ?? '') || ids.has(entry.id)) failures.push(`${label} needs a unique kebab-case id`);
    ids.add(entry?.id);
    if (!MANIFEST_KINDS.includes(entry?.kind)) failures.push(`${label} has unknown kind ${entry?.kind}`);
    // The shared skills directory is optional; every other source must exist.
    const optional = entry?.kind === 'skill' && entry.source === '.agents/skills';
    const sourceValid = typeof entry?.source === 'string' && entry.source.startsWith('.agents/') && (optional || existsSync(join(root, entry.source)));
    if (!sourceValid) failures.push(`${label} source must be an existing path under .agents/`);
    if (entry?.options !== undefined && (typeof entry.options !== 'object' || entry.options === null || Array.isArray(entry.options))) {
      failures.push(`${label} options must be an object`);
    }
    for (const [tool, prefix] of Object.entries(TOOL_PREFIXES)) {
      const target = entry?.targets?.[tool];
      if (target === null) {
        if (!entry.note) failures.push(`${label} has no ${tool} target and needs a note saying how ${tool} gets it`);
      } else if (typeof target !== 'string' || !target.startsWith(prefix)) {
        failures.push(`${label} ${tool} target must be a path under ${prefix} or null`);
      } else if (sourceValid && entry.kind !== 'hook' && depth(target) !== depth(entry.source)) {
        // Hooks merge into settings files; every other kind is copied or linked.
        failures.push(`${label} ${tool} target ${target} is not at the same depth as ${entry.source}, so relative links would break`);
      }
    }
  });

  const sources = new Set(manifest.entries.map((entry) => entry?.source));
  // Learned rules need no entry: the anchor hook loads them for every tool,
  // and the nightly admission may add one without touching the manifest.
  for (const path of ['.agents/rules', '.agents/levels', '.agents/agents'].flatMap((directory) => markdownUnder(root, directory))) {
    if (!sources.has(path) && !path.startsWith('.agents/rules/learned/')) failures.push(`${manifestPath}: ${path} has no manifest entry, so no adapter will carry it`);
  }
  return failures;
}

function isEntrypoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const failures = checkAgentHarness(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (failures.length > 0) {
    console.error(`Agent harness check failed (${failures.length}):\n${failures.map((line) => `- ${line}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Agent harness matches its layout and caps.');
}
