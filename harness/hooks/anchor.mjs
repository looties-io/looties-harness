#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentRequest, effectiveLevel, isEntrypoint, normalize, readStdin, readTranscript, respondContext, toolFromArgv, truncate, truncateBytes } from './lib.mjs';

// Anchor hook (SessionStart and UserPromptSubmit, Claude and Codex). Against
// drift in long sessions it re-injects the base rule, the current level and
// the current request. The full anchor runs at session start, resume and after
// compaction; every other prompt gets the short one. Owned by
// docs/agent-harness.md#safety-nets.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SHORT_ANCHOR_MAX_BYTES = 1200;
const SHORT_REQUEST_MAX_BYTES = 300;

function read(root, path) {
  const absolute = join(root, path);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : '';
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// Repository-relative links read better out of context than ../../ paths.
function flattenLinks(text) {
  return text.replace(/\]\((?:\.\.\/)+/g, '](');
}

function body(text) {
  return flattenLinks(stripFrontmatter(text)).trimStart().replace(/^# .*\n+/, '').trim();
}

// The first sentence of every numbered item of the base rule, links reduced to
// their text: the short anchor is generated, never written by hand.
export function baseRuleDigest(baseRule) {
  return stripFrontmatter(baseRule)
    .split('\n')
    .filter((line) => /^\d+\.\s/.test(line))
    .map((line) => {
      const plain = line.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
      const sentence = /^(.+?[.!?])(?:\s|$)/.exec(plain.replace(/^\d+\.\s+/, ''));
      return `${plain.match(/^\d+\./)[0]} ${sentence ? sentence[1] : plain.replace(/^\d+\.\s+/, '')}`;
    })
    .join('\n');
}

function instinctName(text, source) {
  return /^name:\s*["']?([^"'\n]+)/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '')?.[1].trim() ?? basename(source, '.md');
}

function instinctSources(root) {
  try {
    const manifest = JSON.parse(read(root, '.agents/manifest.json'));
    return manifest.entries.filter((entry) => entry.kind === 'instinct').map((entry) => entry.source);
  } catch {
    return [];
  }
}

function levelLine(level) {
  if (level === null) return 'not announced yet: announce `Level Lx: reason` before acting; L2 when unsure';
  const marker = level >= 1 ? '; open each restatement with an `Understood: <one sentence>` line' : '';
  return `L${level} (the highest announced this session; never lower it${marker})`;
}

// Rules the self-healing loop admitted (docs/agent-harness.md#self-healing-loop).
// Loaded for both tools at session start, resume and compaction; their size is
// capped by the self-healing lint (.agents/healing/lint.mjs).
export function learnedRules(root = ROOT) {
  const directory = join(root, '.agents/rules/learned');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({ name: basename(name, '.md'), text: body(read(root, `.agents/rules/learned/${name}`)) }))
    .filter(({ text }) => text);
}

/**
 * Builds the anchor text. `full` adds the whole base rule, the level file and
 * the instincts; the short form carries the level, the request and a digest.
 */
export function buildAnchor({ full, level, request, root = ROOT }) {
  const baseRule = read(root, '.agents/rules/base.md');
  if (!full) {
    const head = `Harness anchor. Level: ${levelLine(level)}. Base rule (.agents/rules/base.md):\n${baseRuleDigest(baseRule)}`;
    const room = Math.min(SHORT_REQUEST_MAX_BYTES, SHORT_ANCHOR_MAX_BYTES - Buffer.byteLength(`${head}\nRequest: ""`));
    return request && room > 0 ? `${head}\nRequest: "${truncateBytes(request, room)}"` : head;
  }
  const sections = [
    'Harness anchor (session start, resume or compaction). Sources: .agents/; owner: docs/agent-harness.md.',
    `## Base rule\n${body(baseRule)}`,
    level === null ? `## Current level\n${levelLine(null)}.` : `## Current level: L${level}\n${body(read(root, `.agents/levels/L${level}.md`))}`,
  ];
  if (request) sections.push(`## Current request\n"${truncate(request, 600)}"`);
  const instincts = instinctSources(root)
    .map((source) => ({ text: read(root, source), source }))
    .filter(({ text }) => body(text))
    .map(({ text, source }) => `### ${instinctName(text, source)}\n${body(text)}`);
  if (instincts.length > 0) sections.push(`## Instincts\n${instincts.join('\n\n')}`);
  const learned = learnedRules(root);
  if (learned.length > 0) sections.push(`## Learned rules\nAdmitted by the maintainer through the self-healing loop; each tightens a rule above, never loosens it.\n${learned.map(({ name, text }) => `- ${name}: ${text.replace(/\n+/g, ' ')}`).join('\n')}`);
  return sections.join('\n\n');
}

// Claude reports compaction through SessionStart; Codex only leaves a
// compaction record in the transcript, so its first prompt afterwards gets
// the full anchor.
function wantsFull(input, messages) {
  if (input.event === 'SessionStart') return true;
  if (input.tool !== 'codex') return false;
  const lastCompaction = messages.findLastIndex((message) => message.role === 'compaction');
  return lastCompaction !== -1 && !messages.slice(lastCompaction).some((message) => message.role === 'user');
}

export function anchorFor(input, messages, root = ROOT) {
  const withPrompt = input.prompt ? [...messages, { role: 'user', text: input.prompt }] : messages;
  return buildAnchor({ full: wantsFull(input, messages), level: effectiveLevel(withPrompt), request: currentRequest(messages, input.prompt), root });
}

if (isEntrypoint(import.meta.url)) {
  try {
    const input = normalize(readStdin(), toolFromArgv());
    respondContext(input.event || 'UserPromptSubmit', anchorFor(input, readTranscript(input.transcriptPath)));
  } catch (error) {
    process.stderr.write(`agent anchor error: ${error?.stack ?? error}\n`);
  }
}
