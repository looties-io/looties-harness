// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { SHORT_ANCHOR_MAX_BYTES, anchorFor, baseRuleDigest, buildAnchor } from '../harness/hooks/anchor.mjs';
import { currentRequest, effectiveLevel, normalize, readTranscript } from '../harness/hooks/lib.mjs';

// The hook runs from .agents/hooks/ of an installed repository: install the
// package's harness/ into a temporary one, as install.mjs does.
const repoRoot = mkdtempSync(path.join(tmpdir(), 'agent-anchor-installed-'));
cpSync(path.resolve(import.meta.dirname, '..', 'harness'), path.join(repoRoot, '.agents'), { recursive: true });
const hook = path.join(repoRoot, '.agents/hooks/anchor.mjs');
const fixtures = path.join(import.meta.dirname, 'fixtures', 'agent-hooks');
const fixture = (name) => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => rmSync(repoRoot, { recursive: true, force: true }));

describe('transcripts', () => {
  it('reads Claude transcripts without tool results, meta turns, notifications or hook context', () => {
    expect(readTranscript(path.join(fixtures, 'claude-transcript.jsonl'))).toEqual([
      { role: 'user', text: 'Add a retry to the image upload check and open a pull request against dev when it is green.' },
      { role: 'assistant', text: '**Level L1**: logic change in one script, no L2 trigger.' },
      { role: 'user', text: 'yes' },
      { role: 'compaction', text: '' },
    ]);
  });

  it('reads Codex transcripts without injected AGENTS.md or plugin turns', () => {
    const messages = readTranscript(path.join(fixtures, 'codex-transcript.jsonl'));
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'compaction']);
    expect(effectiveLevel(messages)).toBe(0);
  });

  it('returns nothing for a missing transcript', () => {
    expect(readTranscript('/nowhere.jsonl')).toEqual([]);
  });

  it('keeps the highest level announced or set in the session: it only rises', () => {
    expect(effectiveLevel([])).toBeNull();
    expect(effectiveLevel([{ role: 'assistant', text: 'Level L2: migration.' }, { role: 'assistant', text: 'Level L0: tiny.' }])).toBe(2);
    expect(effectiveLevel([{ role: 'assistant', text: 'Niveau **L2** : argent.' }, { role: 'user', text: 'ok, level L1 then' }])).toBe(2);
    expect(effectiveLevel([{ role: 'assistant', text: 'Level L0: typo.' }, { role: 'user', text: 'this is level L2 work' }])).toBe(2);
  });

  it('raises on any L1 or L2 the user mentions, and on an agent saying it raises', () => {
    const L0 = { role: 'assistant', text: 'Level L0: typo.' };
    expect(effectiveLevel([L0, { role: 'user', text: "c'est du L2 en fait, ne merge pas" }])).toBe(2);
    expect(effectiveLevel([L0, { role: 'assistant', text: 'This touches RLS, so I raise to L2.' }])).toBe(2);
    expect(effectiveLevel([L0, { role: 'assistant', text: 'Je passe en L1 pour la suite.' }])).toBe(1);
    expect(effectiveLevel([L0, { role: 'user', text: 'Merci, parfait.' }])).toBe(0);
    expect(effectiveLevel([L0, { role: 'user', text: 'on passe en l2' }])).toBe(2);
    expect(effectiveLevel([L0, { role: 'user', text: 'niveau 2 pour ça' }])).toBe(2);
  });

  it('takes the latest prompt long enough to carry a task as the request', () => {
    const messages = readTranscript(path.join(fixtures, 'claude-transcript.jsonl'));
    expect(currentRequest(messages, 'go')).toMatch(/^Add a retry to the image upload check/);
    expect(currentRequest(messages, 'x'.repeat(90))).toBe('x'.repeat(90));
  });
});

describe('anchor', () => {
  it.each([
    ['ASCII', 'y'.repeat(5000)],
    ['French', 'Corrige la pagination des résultats, vérifie l’accessibilité et évite les régressions. '.repeat(60)],
    ['CJK', '修正分页并检查无障碍功能。'.repeat(400)],
    ['emoji', '🚀✨'.repeat(900)],
  ])('keeps the short anchor within its byte cap with a long %s request', (_label, request) => {
    const text = buildAnchor({ full: false, level: 1, request, root: repoRoot });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(SHORT_ANCHOR_MAX_BYTES);
    expect(text).toContain('Level: L1');
    expect(text).toMatch(/Request: ".+…"$/s);
    expect(text).not.toContain('\uFFFD');
  });

  it('generates the digest from base.md: one first sentence per numbered rule', () => {
    const base = readFileSync(path.join(repoRoot, '.agents/rules/base.md'), 'utf8');
    const digest = baseRuleDigest(base).split('\n');
    expect(digest).toHaveLength(base.split('\n').filter((line) => /^\d+\.\s/.test(line)).length);
    expect(digest[1]).toMatch(/^2\. Announce your level and its reason; L2 is forced for .*the harness\.$/);
    expect(digest[2]).toMatch(/^3\. Only L0 writes to the integration branch after independent review and CI/);
    expect(digest[2]).toContain('eligible docs-only pushes: clean tree and a clean docs check, if configured');
    expect(digest.join('\n')).not.toMatch(/\]\(/);
  });

  it('gives the full anchor at session start, with the base rule, the level file and the request', () => {
    const input = normalize({ ...fixture('claude-session-start.json') }, 'claude');
    const messages = readTranscript(path.join(fixtures, 'claude-transcript.jsonl'));
    const text = anchorFor(input, messages, repoRoot);
    expect(text).toContain('## Base rule');
    expect(text).toContain('## Current level: L1');
    expect(text).toContain(readFileSync(path.join(repoRoot, '.agents/levels/L1.md'), 'utf8').split('\n')[4].replace(/\]\(\.\.\/\.\.\//g, ']('));
    expect(text).toContain('Add a retry to the image upload check');
    expect(text).not.toContain('](../../');
  });

  it('asks for a level when none was announced', () => {
    expect(buildAnchor({ full: true, level: null, request: '', root: repoRoot })).toContain('not announced yet');
  });

  it('gives Codex the full anchor on the first prompt after a compaction, and the short one otherwise', () => {
    const codex = normalize(fixture('codex-user-prompt-submit.json'), 'codex');
    const messages = readTranscript(path.join(fixtures, 'codex-transcript.jsonl'));
    expect(anchorFor(codex, messages, repoRoot)).toContain('## Base rule');
    expect(anchorFor(codex, messages.slice(0, -1), repoRoot)).toMatch(/^Harness anchor\. Level: L0/);
    const claude = normalize(fixture('claude-user-prompt-submit.json'), 'claude');
    expect(anchorFor(claude, readTranscript(path.join(fixtures, 'claude-transcript.jsonl')), repoRoot)).toMatch(/^Harness anchor\. Level: L1/);
  });

  it('loads every instinct listed in the manifest in the full anchor only', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-anchor-'));
    roots.push(root);
    const files = {
      '.agents/rules/base.md': '# Base\n\n1. Rule one. More.\n',
      '.agents/levels/L2.md': '# Level L2\n\n- Wait for the maintainer.\n',
      '.agents/instincts/shared-index.md': '---\nname: shared-index\ndescription: x\nowner: docs/agent-harness.md\nevidence: x\nreviewAfter: 2027-03-27\n---\n\n# Shared index\n\nStage explicit paths.\n',
      '.agents/manifest.json': JSON.stringify({ version: 1, entries: [{ id: 'instinct-shared-index', kind: 'instinct', source: '.agents/instincts/shared-index.md', targets: { claude: null, codex: null }, note: 'anchor' }] }),
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    }
    const full = buildAnchor({ full: true, level: 2, request: 'r', root });
    expect(full).toContain('## Instincts\n### shared-index\nStage explicit paths.');
    expect(full).not.toContain('reviewAfter');
    expect(buildAnchor({ full: false, level: 2, request: 'r', root })).not.toContain('Stage explicit paths');
  });

  it('runs through a symlinked path instead of staying silent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'agent-anchor-link-'));
    roots.push(root);
    const link = path.join(root, 'anchor.mjs');
    symlinkSync(hook, link);
    const payload = { ...fixture('claude-user-prompt-submit.json'), transcript_path: path.join(fixtures, 'claude-transcript.jsonl') };
    expect(JSON.parse(execFileSync('node', [link, '--tool', 'claude'], { input: JSON.stringify(payload), encoding: 'utf8' })).hookSpecificOutput.additionalContext).toMatch(/^Harness anchor/);
  });

  it.each(['claude', 'codex'])('answers with additionalContext in the %s wire format', (tool) => {
    const payload = { ...fixture(`${tool}-user-prompt-submit.json`), transcript_path: path.join(fixtures, `${tool}-transcript.jsonl`) };
    const output = execFileSync('node', [hook, '--tool', tool], { input: JSON.stringify(payload), encoding: 'utf8' });
    const answer = JSON.parse(output).hookSpecificOutput;
    expect(answer.hookEventName).toBe('UserPromptSubmit');
    expect(answer.additionalContext).toMatch(/^Harness anchor/);
    expect(answer.additionalContext).toContain('route the task, read only what applies');
  });
});

describe('self-healing additions to the anchor', () => {
  const layout = () => {
    const root = mkdtempSync(path.join(tmpdir(), 'anchor-learned-'));
    roots.push(root);
    for (const directory of ['.agents/rules/learned', '.agents/levels', '.agents/instincts']) mkdirSync(path.join(root, directory), { recursive: true });
    writeFileSync(path.join(root, '.agents/rules/base.md'), '# Base Rule\n\n1. Follow AGENTS.md.\n');
    writeFileSync(path.join(root, '.agents/levels/L1.md'), '# Level L1\n\n- Deliver.\n');
    writeFileSync(path.join(root, '.agents/manifest.json'), JSON.stringify({ version: 1, entries: [] }));
    return root;
  };

  it('loads admitted learned rules into the full anchor, without their frontmatter', () => {
    const root = layout();
    writeFileSync(path.join(root, '.agents/rules/learned/run-touched-tests.md'), '---\nname: run-touched-tests\nissue: https://example.invalid/1\n---\n\nRun the tests of the touched module\nbefore committing.\n');
    const text = buildAnchor({ full: true, level: 1, request: '', root });
    expect(text).toContain('## Learned rules');
    expect(text).toContain('- run-touched-tests: Run the tests of the touched module before committing.');
    expect(text).toContain('Admitted by the maintainer');
    expect(text).not.toContain('issue: https://example.invalid/1');
    expect(buildAnchor({ full: true, level: 1, request: '', root: layout() })).not.toContain('## Learned rules');
  });

  it('asks for the Understood restatement from L1 up in the short anchor', () => {
    expect(buildAnchor({ full: false, level: 2, request: 'x', root: layout() })).toContain('`Understood: <one sentence>`');
    expect(buildAnchor({ full: false, level: 0, request: 'x', root: layout() })).not.toContain('Understood');
  });
});
