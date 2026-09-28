// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAgentHarness } from '../harness/check.mjs';

const harnessSource = path.resolve(import.meta.dirname, '..', 'harness');
const roots = [];

const rule = (paths = ['src/**']) => `---\npaths:\n${paths.map((glob) => `  - "${glob}"`).join('\n')}\n---\n\n# Rule\n\n- See [standard](../../docs/x.md).\n`;

// A minimal harness that passes every check; each test breaks one thing.
function harness({ files = {}, entries } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-harness-'));
  roots.push(root);
  const tree = {
    '.agents/rules/base.md': '# Base\n\n1. Rule.\n',
    '.agents/rules/frontend.md': rule(),
    '.agents/levels/L0.md': '# L0\n',
    ...files,
  };
  for (const [file, content] of Object.entries(tree)) {
    if (content === null) continue;
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  const manifest = {
    version: 1,
    entries: entries ?? [
      { id: 'rules-base', kind: 'rule', source: '.agents/rules/base.md', targets: { claude: '.claude/rules/base.md', codex: null }, note: 'anchor' },
      { id: 'rules-frontend', kind: 'rule', source: '.agents/rules/frontend.md', targets: { claude: '.claude/rules/frontend.md', codex: null }, note: 'routing' },
      { id: 'level-l0', kind: 'level', source: '.agents/levels/L0.md', targets: { claude: null, codex: null }, note: 'anchor' },
    ],
  };
  writeFileSync(path.join(root, '.agents/manifest.json'), JSON.stringify(manifest));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('checkAgentHarness', () => {
  // The package's harness/ is what install.mjs copies to .agents/.
  it('passes on the harness as installed, with its config and example', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-harness-installed-'));
    roots.push(root);
    cpSync(harnessSource, path.join(root, '.agents'), { recursive: true });
    writeFileSync(path.join(root, '.agents/harness.config.json'), '{}\n');
    expect(checkAgentHarness(root)).toEqual([]);
  });

  it('accepts a manifest whose optional skills directory is absent', () => {
    const entries = [
      { id: 'rules-base', kind: 'rule', source: '.agents/rules/base.md', targets: { claude: '.claude/rules/base.md', codex: null }, note: 'anchor' },
      { id: 'rules-frontend', kind: 'rule', source: '.agents/rules/frontend.md', targets: { claude: '.claude/rules/frontend.md', codex: null }, note: 'routing' },
      { id: 'level-l0', kind: 'level', source: '.agents/levels/L0.md', targets: { claude: null, codex: null }, note: 'anchor' },
      { id: 'skills', kind: 'skill', source: '.agents/skills', targets: { claude: '.claude/skills', codex: null }, note: 'native' },
    ];
    expect(checkAgentHarness(harness({ entries }))).toEqual([]);
  });

  it('passes on the minimal fixture', () => {
    expect(checkAgentHarness(harness())).toEqual([]);
  });

  it('rejects entries outside the layout', () => {
    const root = harness({ files: { '.agents/bogus/x.md': '# x\n', '.agents/stray.txt': 'x' } });
    const failures = checkAgentHarness(root);
    expect(failures).toContain('.agents/bogus: not part of the agent harness layout in docs/agent-harness.md');
    expect(failures).toContain('.agents/stray.txt: not part of the agent harness layout in docs/agent-harness.md');
  });

  it('caps the base rule by lines and bytes', () => {
    expect(checkAgentHarness(harness({ files: { '.agents/rules/base.md': 'x\n'.repeat(26) } })))
      .toContainEqual(expect.stringContaining('26 lines, over the 25-line cap'));
    expect(checkAgentHarness(harness({ files: { '.agents/rules/base.md': `${'x'.repeat(2049)}\n` } })))
      .toContainEqual(expect.stringContaining('over the 2048-byte cap'));
  });

  it('reports a missing base rule', () => {
    expect(checkAgentHarness(harness({ files: { '.agents/rules/base.md': null } })))
      .toContain('.agents/rules/base.md: missing base rule');
  });

  it('requires frontmatter that opens the file', () => {
    const late = `# Rule\n\n---\npaths:\n  - "src/**"\n---\n\n[s](../../docs/x.md)\n`;
    expect(checkAgentHarness(harness({ files: { '.agents/rules/frontend.md': late } })))
      .toContainEqual(expect.stringContaining('needs `paths:` in frontmatter'));
  });

  it('accepts CRLF frontmatter', () => {
    const crlf = rule().replace(/\n/g, '\r\n');
    expect(checkAgentHarness(harness({ files: { '.agents/rules/frontend.md': crlf } }))).toEqual([]);
  });

  it('requires a link to a document under docs/', () => {
    const noLink = '---\npaths:\n  - "src/**"\n---\n\n[x](../../AGENTS.md)\n';
    expect(checkAgentHarness(harness({ files: { '.agents/rules/frontend.md': noLink } })))
      .toContainEqual(expect.stringContaining('must link to at least one document under docs/'));
  });

  // The anchor hook carries learned rules, and the nightly admission commit
  // may not touch the manifest, so a learned rule needs no manifest entry.
  it('caps learned rules without a manifest entry or the path-rule shape', () => {
    const failures = checkAgentHarness(harness({ files: { '.agents/rules/learned/r1.md': 'x\n'.repeat(21) } }));
    expect(failures).toContainEqual(expect.stringContaining('.agents/rules/learned/r1.md: 21 lines'));
    expect(failures.some((failure) => failure.includes('learned/r1.md has no manifest entry'))).toBe(false);
    expect(failures.some((failure) => failure.includes('learned/r1.md: a path-scoped rule'))).toBe(false);
  });

  it('validates manifest entries', () => {
    const base = { kind: 'rule', source: '.agents/rules/base.md', targets: { claude: '.claude/rules/base.md', codex: null }, note: 'n' };
    const failures = checkAgentHarness(harness({
      entries: [
        { ...base, id: 'Bad_Id' },
        { ...base, id: 'dup' },
        { ...base, id: 'dup' },
        { ...base, id: 'kind', kind: 'nope' },
        { ...base, id: 'missing', source: '.agents/rules/none.md' },
        { ...base, id: 'prefix', targets: { claude: '.codex/rules/base.md', codex: null } },
        { ...base, id: 'no-note', note: undefined },
        { ...base, id: 'depth', targets: { claude: '.claude/base.md', codex: null } },
        { ...base, id: 'options', options: 'x' },
        { id: 'hook', kind: 'hook', source: '.agents/rules/base.md', targets: { claude: '.claude/settings.json', codex: '.codex/hooks.json' }, options: { event: 'PreToolUse' } },
      ],
    }));
    for (const expected of [
      'entry Bad_Id needs a unique kebab-case id',
      'entry dup needs a unique kebab-case id',
      'entry kind has unknown kind nope',
      'entry missing source must be an existing path under .agents/',
      'entry prefix claude target must be a path under .claude/ or null',
      'entry no-note has no codex target and needs a note',
      'entry depth claude target .claude/base.md is not at the same depth',
      'entry options options must be an object',
      '.agents/rules/frontend.md has no manifest entry',
    ]) {
      expect(failures).toContainEqual(expect.stringContaining(expected));
    }
    expect(failures.some((failure) => failure.includes('entry hook'))).toBe(false);
  });

  it('rejects an unsupported manifest version and unreadable JSON', () => {
    const root = harness();
    writeFileSync(path.join(root, '.agents/manifest.json'), JSON.stringify({ version: 2, entries: [] }));
    expect(checkAgentHarness(root)).toContainEqual(expect.stringContaining('unsupported version 2'));
    writeFileSync(path.join(root, '.agents/manifest.json'), '{');
    expect(checkAgentHarness(root)).toContainEqual(expect.stringMatching(/^\.agents\/manifest\.json: /));
  });
});
