#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, productionCommandNames } from './harness/hooks/config.mjs';

// Installs the harness into a repository:
//
//   node install.mjs <target-repo> [--force]
//
// 1. Copies harness/ to <target>/.agents/. Existing harness files are only
//    overwritten with --force; .agents/harness.config.json never is.
// 2. Creates .agents/harness.config.json from the example when it is absent.
// 3. Copies docs/agent-harness.md when the target has none.
// 4. Adds an `ask` rule to .claude/settings.json for each configured
//    production command (never removes a rule), then generates .claude/ and
//    .codex/ with `node .agents/sync-adapters.mjs`.
//
// The generator owns .claude/rules, .claude/agents, .codex/agents and the
// hooks of .claude/settings.json and .codex/hooks.json: it replaces whatever
// they hold. The installer lists what would be lost and stops unless --force.
// Zero dependencies. Owned by docs/agent-harness.md#sources-and-adapters.

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(PACKAGE_ROOT, 'harness');
const STANDARD = join('docs', 'agent-harness.md');
const CONFIG = join('.agents', 'harness.config.json');
const EXAMPLE = join('.agents', 'harness.config.example.json');
const FALLBACK_CONFIG = { branches: { integration: 'dev', release: 'main' } };
export const V2_SKILLS = ['code-cleanup', 'impossible-by-design', 'harness-testing', 'agentic-peer-review', 'security-hardening'];
export const V2_ROUTING = `<!-- lstack-v2:start -->
## L-stack V2

Read the repository harness standard and [V2 execution policy](docs/lstack-v2.md).
For code changes, read the applicable installed skills before intervention: code-cleanup for structural quality, impossible-by-design for recurring defects, and harness-testing for real behavioral checks. Use agentic-peer-review and security-hardening for cumulative campaigns. Inspect the local catalog; do not substitute a skill name for its complete instructions.
For an approved long mission, an explicit unattended request (including "I am going to bed; finish this"), a restart or periodic hardening, read [.agents/skills/lstack-workflow/SKILL.md](.agents/skills/lstack-workflow/SKILL.md) and use its durable receipt commands. Resume existing work and authorization. Block only the action needing a new approval; continue independent authorized work. Preserve existing review and merge rules.
<!-- lstack-v2:end -->`;

function filesUnder(root, directory = '') {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(root, path) : [path];
  });
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`${path}: ${error.message}`);
  }
}

// Files the generator would replace or delete that it did not write itself:
// every adapter the package manifest does not produce, and hooks already
// registered in the settings files.
export function adapterConflicts(target) {
  const manifest = readJson(join(SOURCE, 'manifest.json'), { entries: [] });
  const generated = new Set(manifest.entries.flatMap((entry) => Object.values(entry.targets ?? {}).filter(Boolean)));
  const conflicts = [];
  for (const directory of ['.claude/rules', '.claude/agents', '.codex/agents']) {
    if (!existsSync(join(target, directory))) continue;
    for (const name of readdirSync(join(target, directory))) {
      const path = `${directory}/${name}`;
      if (!generated.has(path)) conflicts.push(`${path}: would be deleted (not generated from .agents/)`);
    }
  }
  // .claude/skills is generated only when the target shares skills in .agents/skills.
  const skills = join(target, '.agents', 'skills');
  if (existsSync(skills) && existsSync(join(target, '.claude/skills'))) {
    for (const name of readdirSync(join(target, '.claude/skills'))) {
      if (!existsSync(join(skills, name, 'SKILL.md'))) conflicts.push(`.claude/skills/${name}: would be deleted (not a skill under .agents/skills/)`);
    }
  }
  const state = readJson(join(target, '.agents', 'manifest.state.json'), null);
  // A repository the harness already manages owns its hooks through the manifest.
  if (state === null) {
    for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
      const hooks = readJson(join(target, file), {})?.hooks;
      if (hooks && Object.keys(hooks).length > 0) conflicts.push(`${file}: its hooks (${Object.keys(hooks).join(', ')}) would be replaced by the generated ones`);
    }
    if (existsSync(join(target, '.codex/config.toml'))) conflicts.push('.codex/config.toml: would be replaced by the generated one');
  }
  return conflicts;
}

// Seeds the second layer behind the guard: one ask rule per production
// command. Hand-maintained keys stay; nothing is removed.
function seedAskRules(target) {
  const commands = productionCommandNames(loadConfig(target));
  if (commands.length === 0) return [];
  const path = join(target, '.claude', 'settings.json');
  const settings = readJson(path, {});
  settings.permissions ??= {};
  settings.permissions.ask ??= [];
  const added = commands.map((command) => `Bash(${command}:*)`).filter((rule) => !settings.permissions.ask.includes(rule));
  if (added.length === 0) return [];
  settings.permissions.ask.push(...added);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  return added;
}

/**
 * Installs the harness into `target`. Returns { ok, messages }; `ok` false
 * means nothing was written (a refusal) or the generator reported problems.
 */
export function install(target, { force = false, skillsRoot = null, log = () => {} } = {}) {
  const root = resolve(target);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return { ok: false, messages: [`${target}: not a directory`] };
  if (realpathSync(root) === realpathSync(PACKAGE_ROOT)) return { ok: false, messages: ['Install into another repository, not into the harness package itself.'] };

  const sources = filesUnder(SOURCE);
  if (skillsRoot) {
    const missing = V2_SKILLS.filter((name) => !existsSync(join(skillsRoot, name, 'SKILL.md')));
    if (missing.length) return { ok: false, messages: [`Missing selected skill sources: ${missing.join(', ')}. Nothing was written.`] };
  }
  const existing = sources.map((file) => join('.agents', file)).filter((file) => existsSync(join(root, file)) && file !== CONFIG);
  if (skillsRoot) existing.push(...V2_SKILLS.map((name) => `.agents/skills/${name}`).filter((file) => existsSync(join(root, file))));
  const conflicts = adapterConflicts(root);
  if (!force && (existing.length > 0 || conflicts.length > 0)) {
    const messages = [];
    if (existing.length > 0) messages.push(`${existing.length} harness file(s) already exist under .agents/ (first: ${existing[0]}).`);
    messages.push(...conflicts);
    messages.push('Nothing was written. Move your own adapters into .agents/ (with a manifest entry each), or rerun with --force to overwrite. --force never touches .agents/harness.config.json.');
    return { ok: false, messages };
  }

  // Copy file by file so the one maintainer-owned file is never overwritten.
  for (const file of sources) {
    const destination = join(root, '.agents', file);
    if (join('.agents', file) === CONFIG) continue;
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(SOURCE, file), destination);
  }
  log(`Copied ${sources.length} harness files to .agents/.`);
  if (skillsRoot) for (const name of V2_SKILLS) cpSync(join(skillsRoot, name), join(root, '.agents/skills', name), { recursive: true });

  if (!existsSync(join(root, CONFIG))) {
    const example = existsSync(join(root, EXAMPLE)) ? readFileSync(join(root, EXAMPLE), 'utf8') : `${JSON.stringify(FALLBACK_CONFIG, null, 2)}\n`;
    writeFileSync(join(root, CONFIG), example);
    log(`Created ${CONFIG} from the example: edit it for your branches, CI workflow and production commands.`);
  } else {
    log(`Kept your ${CONFIG}.`);
  }

  if (!existsSync(join(root, STANDARD)) && existsSync(join(PACKAGE_ROOT, STANDARD))) {
    mkdirSync(join(root, 'docs'), { recursive: true });
    cpSync(join(PACKAGE_ROOT, STANDARD), join(root, STANDARD));
    log(`Copied the standard to ${STANDARD}.`);
  }

  const policy = join(root, 'docs/lstack-v2.md');
  if (!existsSync(policy) || force) { mkdirSync(dirname(policy), { recursive: true }); cpSync(join(PACKAGE_ROOT, 'docs/lstack-v2.md'), policy); }
  const entrypoint = join(root, 'AGENTS.md');
  const instructions = existsSync(entrypoint) ? readFileSync(entrypoint, 'utf8') : '# Agent instructions\n';
  if (!instructions.includes('<!-- lstack-v2:start -->')) writeFileSync(entrypoint, `${instructions.trimEnd()}\n\n${V2_ROUTING}\n`);
  if (!existsSync(join(root, 'CLAUDE.md'))) writeFileSync(join(root, 'CLAUDE.md'), '@AGENTS.md\n');

  const added = seedAskRules(root);
  if (added.length > 0) log(`Added ${added.length} ask rule(s) to .claude/settings.json for the production commands.`);

  try {
    log(execFileSync(process.execPath, [join('.agents', 'sync-adapters.mjs')], { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim());
  } catch (error) {
    return { ok: false, messages: [`node .agents/sync-adapters.mjs failed:\n${String(error.stderr ?? error.message).trim()}`] };
  }
  return { ok: true, messages: [] };
}

export function nextSteps(target) {
  return [
    `Next steps, in ${resolve(target)}:`,
    `1. Edit ${CONFIG} (branches, CI workflow, production commands), then run \`node .agents/sync-adapters.mjs\` in the repository.`,
    '2. Review the V2 routing added to AGENTS.md and the CLAUDE.md import. Supply --skills-root <looties-skills-checkout> to install the five selected quality/security skills, or map the existing local equivalents before using their routes.',
    '3. Codex: open the repository once and trust the project, or .codex/hooks.json never runs.',
    '4. Install RTK (`brew install rtk && rtk init -g`, plus `rtk init -g --codex`) and caveman (`npx skills add JuliusBrussee/caveman -g`): they keep long multi-agent sessions inside their context budget, and the user-level rules assume both.',
    '5. Copy the user-level template user-level/AGENTS.md from the harness package to ~/.agents/AGENTS.md and adapt it.',
    '6. Check the harness any time with `node .agents/check.mjs` and `node .agents/sync-adapters.mjs --check`, and commit .agents/, .claude/, .codex/ and docs/agent-harness.md.',
  ].join('\n');
}

function isEntrypoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const args = process.argv.slice(2);
  const positional = []; let skillsRoot = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--skills-root') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--skills-root requires a path');
      skillsRoot = resolve(args[++index]);
    } else if (args[index] === '--force' || args[index] === '--help') continue;
    else if (args[index].startsWith('--')) throw new Error(`Unknown option: ${args[index]}`);
    else positional.push(args[index]);
  }
  if (positional.length > 1) throw new Error('Specify exactly one target repository');
  const target = positional[0];
  if (!target || args.includes('--help')) {
    console.error('Usage: node install.mjs <target-repo> [--force] [--skills-root PATH]');
    process.exit(target ? 0 : 1);
  }
  const { ok, messages } = install(target, { force: args.includes('--force'), skillsRoot, log: (line) => console.log(line) });
  if (!ok) {
    console.error(messages.join('\n'));
    process.exit(1);
  }
  console.log(`\nHarness installed.\n\n${nextSteps(target)}`);
}
