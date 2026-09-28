#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendRecord, journalMuted, readRecords, writeDocument } from './journal.mjs';
import { effectiveLevel, isEntrypoint, normalize, readStdin, readTranscript, toolFromArgv, truncate } from './lib.mjs';

// Self-healing hook (Claude and Codex). On UserPromptSubmit it records the
// interpretation ledger of design decision 13: when the previous assistant
// message carried an `Understood:` restatement (or its French form
// `Compris :`), the user's reply is classified validated, corrected, rejected
// or unclear and the pair goes to the agent journal. At
// session end (Claude SessionEnd, Codex Stop) it writes an idempotent summary
// of the session: skills used, pre-commit failures, guard verdicts and ledger
// classes, which the nightly pass turns into candidate rules. It never blocks
// and never adds context. Owned by docs/agent-harness.md#self-healing-loop.

// `Understood:` is the documented marker; `Compris :` is accepted too.
export const RESTATEMENT_MARKER = /^[ \t>*_-]*(?:Understood|Compris)\s*:[*_\s]*(.+)$/im;

/** The one-sentence restatement a message carries, or null. */
export function restatementOf(text) {
  const match = RESTATEMENT_MARKER.exec(String(text ?? ''));
  return match ? match[1].replace(/[*_]+$/, '').trim() : null;
}

// Word boundaries that understand accented letters (\b does not: `validé`, `à la place`).
const words = (alternatives) => `(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`;
const REJECTED = new RegExp(`^\\s*${words("stop|annule|abandonne|laisse tomber|pas du tout|c'est pas (?:ça|ca)|ce n'est pas (?:ça|ca)|t'as (?:rien|pas) compris|tu n'as pas compris|wrong|that's not it|not at all")}`, 'iu');
const BARE_NO = /^\s*(?:non|no|nope)[\s.!]*$/iu;
const LEADING_NO = new RegExp(`^\\s*${words('non|no|nope')}`, 'iu');
const CORRECTED = new RegExp(words('mais|sauf|plutôt|plutot|en fait|par contre|attention|bémol|bemol|je (?:précise|precise|corrige|nuance)|nuance|à la place|a la place|au lieu|instead|but|actually|rather|except|however'), 'iu');
const VALIDATED = new RegExp(`^\\s*(?:${words("oui|yes|yep|ok|okay|go|vas[- ]y|validée?s?|valide|parfait|c'est bon|d'accord|dac|top|nickel|lgtm|ça me va|ca me va|exactement|exact|carrément|carrement")}|👍|✅)`, 'iu');
const ALL_DEFAULTS = new RegExp(words('oui à tout|oui a tout|yes to all|go pour tout|ok pour tout'), 'iu');

/** Classifies the user's reply to a restatement. Heuristic; the review can relabel it. */
export function classifyReply(reply) {
  const text = String(reply ?? '').replace(/<\/?pasted_content[^>]*>/g, ' ').trim();
  if (!text) return 'unclear';
  if (REJECTED.test(text) || BARE_NO.test(text)) return 'rejected';
  if (LEADING_NO.test(text) || CORRECTED.test(text)) return 'corrected';
  if (ALL_DEFAULTS.test(text) || VALIDATED.test(text)) return 'validated';
  return 'unclear';
}

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 16);

/**
 * The ledger record for `prompt`, when it is the first reply to an assistant
 * message carrying a restatement; otherwise null. `messages` is the transcript
 * before the prompt (a copy of the prompt at its end is ignored).
 */
export function ledgerRecord({ sessionId, tool, prompt }, messages) {
  const history = messages.at(-1)?.role === 'user' && messages.at(-1).text.trim() === String(prompt).trim() ? messages.slice(0, -1) : messages;
  let index = history.length - 1;
  while (index >= 0 && history[index].role === 'assistant' && !restatementOf(history[index].text)) {
    // Several assistant messages can follow one another within a turn; the
    // restatement is usually the last, but look back through the whole turn.
    index -= 1;
  }
  if (index < 0 || history[index].role !== 'assistant') return null;
  if (history.slice(index + 1).some((message) => message.role === 'user')) return null;
  const restatement = restatementOf(history[index].text);
  if (!restatement || !String(prompt ?? '').trim()) return null;
  return {
    kind: 'interpretation',
    key: hash(`${sessionId}\n${restatement}`),
    sessionId,
    tool,
    level: effectiveLevel(history),
    restatement: truncate(restatement, 500),
    assistantExcerpt: truncate(history[index].text, 1500),
    reply: truncate(String(prompt), 2000),
    class: classifyReply(prompt),
    method: 'heuristic',
  };
}

// ------------------------------------------------------------ session summary

function rawEntries(path) {
  if (!path) return [];
  try {
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const SKILL_FILE = /(?:^|[/\s'"])\.?agents\/skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md/g;

// Tool calls and results in both transcript formats, as { kind, name, text }.
export function toolActivity(entries) {
  const activity = [];
  for (const entry of entries) {
    const content = entry?.message?.content;
    if (Array.isArray(content) && !entry.isSidechain) {
      for (const part of content) {
        if (part?.type === 'tool_use') activity.push({ kind: 'call', name: String(part.name ?? ''), text: JSON.stringify(part.input ?? {}) });
        if (part?.type === 'tool_result') {
          const text = typeof part.content === 'string' ? part.content : (Array.isArray(part.content) ? part.content.map((item) => item?.text ?? '').join('\n') : '');
          activity.push({ kind: 'result', name: '', text, error: part.is_error === true });
        }
      }
    }
    const payload = entry?.type === 'response_item' ? entry.payload : null;
    if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') activity.push({ kind: 'call', name: String(payload.name ?? ''), text: String(payload.arguments ?? payload.input ?? '') });
    if (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output') activity.push({ kind: 'result', name: '', text: typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '') });
  }
  return activity;
}

export function skillsUsed(activity) {
  const skills = new Set();
  for (const { kind, name, text } of activity) {
    if (kind !== 'call') continue;
    if (name === 'Skill') {
      try {
        const skill = JSON.parse(text).skill;
        if (skill) skills.add(String(skill));
      } catch {
        // Not JSON: fall through to the path scan.
      }
    }
    for (const match of text.matchAll(SKILL_FILE)) skills.add(match[1]);
  }
  return [...skills].sort();
}

export function precommitFailures(activity) {
  return activity
    .filter(({ kind, text }) => kind === 'result' && /\[pre-commit\][^\n]*(?:failed|refus|commit again)/i.test(text))
    .map(({ text }) => truncate(text.split('\n').find((line) => /\[pre-commit\][^\n]*(?:failed|refus|commit again)/i.test(line)) ?? '', 200));
}

function branchOf(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const tally = (items) => items.reduce((counts, item) => ({ ...counts, [item]: (counts[item] ?? 0) + 1 }), {});

export const CLASSES = Object.freeze(['validated', 'corrected', 'rejected', 'unclear']);

/** The interpretation records with the latest relabel applied. */
export function effectiveRecords(records) {
  const relabels = new Map();
  for (const record of records) if (record.kind === 'relabel' && CLASSES.includes(record.class)) relabels.set(record.key, record.class);
  return records.filter((record) => record.kind === 'interpretation').map((record) => (relabels.has(record.key) ? { ...record, class: relabels.get(record.key), method: 'relabelled' } : record));
}

export function sessionSummary(input, { messages, entries, events, ledger, branch = '' }) {
  const activity = toolActivity(entries);
  const guard = events.filter((event) => event.kind === 'guard' && event.sessionId === input.sessionId);
  return {
    kind: 'session',
    sessionId: input.sessionId,
    tool: input.tool,
    cwd: input.cwd,
    branch,
    level: effectiveLevel(messages),
    userMessages: messages.filter((message) => message.role === 'user').length,
    skills: skillsUsed(activity),
    precommitFailures: precommitFailures(activity),
    guard: tally(guard.map((event) => event.decision)),
    guardReasons: [...new Set(guard.map((event) => event.rule).filter(Boolean))],
    ledger: tally(effectiveRecords(ledger).filter((record) => record.sessionId === input.sessionId).map((record) => record.class)),
  };
}

// ------------------------------------------------------------------------ CLI

if (isEntrypoint(import.meta.url) && !journalMuted()) {
  try {
    const input = normalize(readStdin(), toolFromArgv());
    if (input.sessionId && input.event === 'UserPromptSubmit') {
      const record = ledgerRecord(input, readTranscript(input.transcriptPath));
      if (record) appendRecord('ledger', record);
    } else if (input.sessionId && (input.event === 'SessionEnd' || input.event === 'Stop')) {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const summary = sessionSummary(input, {
        messages: readTranscript(input.transcriptPath),
        entries: rawEntries(input.transcriptPath),
        events: readRecords('events', { since }),
        ledger: readRecords('ledger', { since }),
        branch: branchOf(input.cwd),
      });
      writeDocument(`sessions/${new Date().toISOString().slice(0, 7)}/${input.sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`, { at: new Date().toISOString(), ...summary });
    }
  } catch (error) {
    // The journal is evidence, never a gate: a failure here must not block a session.
    process.stderr.write(`self-healing hook error: ${error?.message ?? error}\n`);
  }
}
