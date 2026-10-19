// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = path.resolve(import.meta.dirname, '..');
const installer = path.join(packageRoot, 'install.mjs');
// Inside a git hook, git exports GIT_DIR and friends; inherited, they would
// point the fixture's `git init` at the real repository.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), 'harness-install-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, env });
  return root;
}

// Runs the installer CLI; returns its exit status and output instead of throwing.
function run(target, ...flags) {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [installer, target, ...flags], { encoding: 'utf8', stdio: 'pipe', env }), stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

const read = (root, file) => readFileSync(path.join(root, file), 'utf8');
const node = (root, ...args) => execFileSync(process.execPath, args, { cwd: root, encoding: 'utf8', stdio: 'pipe', env });

describe('install.mjs', () => {
  it('connects V2 to the canonical entrypoint without replacing local instructions', () => {
    const root = repository(); writeFileSync(path.join(root, 'AGENTS.md'), '# Local policy\nKeep the existing owner.\n');
    expect(run(root).status).toBe(0);
    expect(read(root, 'AGENTS.md')).toContain('Keep the existing owner.');
    expect(read(root, 'AGENTS.md')).toContain('.agents/skills/lstack-workflow/SKILL.md');
    expect(existsSync(path.join(root, '.agents/runtime/mission.mjs'))).toBe(true);
    expect(existsSync(path.join(root, 'docs/lstack-v2.md'))).toBe(true);
    expect(run(root, '--force').status).toBe(0);
    expect(read(root, 'AGENTS.md').match(/<!-- lstack-v2:start -->/g)).toHaveLength(1);
  });

  it('refuses an incomplete selected skill bundle before writing anything', () => {
    const root = repository(); const skills = repository();
    expect(run(root, '--skills-root', skills).status).toBe(1);
    expect(existsSync(path.join(root, '.agents'))).toBe(false);
  });

  it('accepts a complete selected bundle before the positional target without installing into the source', () => {
    const root = repository(); const skills = repository();
    for (const name of ['code-cleanup', 'impossible-by-design', 'harness-testing', 'agentic-peer-review', 'security-hardening']) {
      mkdirSync(path.join(skills, name)); writeFileSync(path.join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: "Fixture"\n---\nRead the contract.\n`);
    }
    expect(run('--skills-root', skills, root).status).toBe(0);
    expect(existsSync(path.join(skills, '.agents'))).toBe(false);
    expect(read(root, '.agents/skills/code-cleanup/SKILL.md')).toContain('Read the contract.');
    expect(node(root, '.agents/sync-adapters.mjs', '--check')).toContain('Agent adapters match');
  });
  it('installs .agents/, generates clean adapters and prints the next steps', () => {
    const root = repository();
    const { status, stdout } = run(root);
    expect(status).toBe(0);
    for (const file of ['.agents/manifest.json', '.agents/sync-adapters.mjs', '.agents/check.mjs', '.agents/hooks/anchor.mjs', '.agents/harness.config.json', '.claude/settings.json', '.claude/rules/base.md', '.claude/agents/reviewer.md', '.codex/hooks.json', '.codex/config.toml', '.codex/agents/reviewer.toml', '.agents/manifest.state.json']) {
      expect(existsSync(path.join(root, file)), file).toBe(true);
    }
    expect(node(root, '.agents/sync-adapters.mjs', '--check')).toMatch(/Agent adapters match \.agents\//);
    expect(node(root, '.agents/check.mjs')).toMatch(/matches its layout and caps/);
    expect(stdout).toMatch(/Next steps/);
    expect(stdout).toMatch(/trust the project/);
    expect(stdout).toMatch(/RTK/);
    expect(stdout).toMatch(/caveman/);
    expect(stdout).toMatch(/user-level\/AGENTS\.md/);
  });

  it('creates the config from the example and seeds one ask rule per production command', () => {
    const root = repository();
    expect(run(root).status).toBe(0);
    const example = path.join(packageRoot, 'harness/harness.config.example.json');
    if (existsSync(example)) expect(read(root, '.agents/harness.config.json')).toBe(readFileSync(example, 'utf8'));
    const config = JSON.parse(read(root, '.agents/harness.config.json'));
    const asks = JSON.parse(read(root, '.claude/settings.json')).permissions?.ask ?? [];
    for (const { command } of config.productionCommands ?? []) expect(asks).toContain(`Bash(${command}:*)`);
  });

  it('copies the standard only when the target has none', () => {
    const root = repository();
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(root, 'docs/agent-harness.md'), '# Ours\n');
    expect(run(root).status).toBe(0);
    expect(read(root, 'docs/agent-harness.md')).toBe('# Ours\n');
    const fresh = repository();
    expect(run(fresh).status).toBe(0);
    expect(existsSync(path.join(fresh, 'docs/agent-harness.md'))).toBe(existsSync(path.join(packageRoot, 'docs/agent-harness.md')));
  });

  it('refuses a second run without --force, and never overwrites the config even with it', () => {
    const root = repository();
    expect(run(root).status).toBe(0);
    const config = '{ "branches": { "integration": "develop", "release": "production" } }\n';
    writeFileSync(path.join(root, '.agents/harness.config.json'), config);
    writeFileSync(path.join(root, '.agents/rules/base.md'), 'edited\n');

    const refused = run(root);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/already exist under \.agents\/.*Nothing was written/s);
    expect(read(root, '.agents/rules/base.md')).toBe('edited\n');

    expect(run(root, '--force').status).toBe(0);
    expect(read(root, '.agents/rules/base.md')).toBe(read(packageRoot, 'harness/rules/base.md'));
    expect(read(root, '.agents/harness.config.json')).toBe(config);
    expect(node(root, '.agents/sync-adapters.mjs', '--check')).toMatch(/match/);
  });

  it('refuses to replace adapters and hooks the repository already has', () => {
    const root = repository();
    mkdirSync(path.join(root, '.claude/agents'), { recursive: true });
    writeFileSync(path.join(root, '.claude/agents/mine.md'), '---\nname: mine\n---\n');
    writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true' }] }] } }));
    const refused = run(root);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('.claude/agents/mine.md: would be deleted');
    expect(refused.stderr).toContain('.claude/settings.json: its hooks (Stop) would be replaced');
    expect(existsSync(path.join(root, '.agents'))).toBe(false);
  });

  it('refuses a missing target and prints its usage without one', () => {
    expect(run(path.join(tmpdir(), 'harness-install-nowhere-x')).stderr).toMatch(/not a directory/);
    const usage = (() => {
      try {
        execFileSync(process.execPath, [installer], { encoding: 'utf8', stdio: 'pipe' });
        return '';
      } catch (error) {
        return String(error.stderr);
      }
    })();
    expect(usage).toMatch(/Usage: node install\.mjs <target-repo> \[--force\]/);
  });
});
