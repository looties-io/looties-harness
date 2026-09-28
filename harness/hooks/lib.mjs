import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Shared plumbing for the harness hooks: reading the payload each tool sends,
// writing the answer each tool understands, and reading the session
// transcript. The behaviour is owned by docs/agent-harness.md.
//
// Verified against Claude Code 2.1.283 and Codex 0.155:
// - Claude honours a PreToolUse `ask` even in bypassPermissions mode and with a
//   user-level bare `Bash` allow rule.
// - Codex rejects `ask` and `allow` as a PreToolUse decision and then runs the
//   command anyway, so a Codex answer is only ever `deny` or nothing.

export function toolFromArgv(argv = process.argv) {
  const index = argv.indexOf('--tool');
  const tool = index === -1 ? undefined : argv[index + 1];
  return tool === 'codex' ? 'codex' : 'claude';
}

// True when the module at `url` is the script node was started with. Both
// sides are resolved, so a symlinked path to the script still runs it: a
// check that silently skipped would fail open.
export function isEntrypoint(url, argv = process.argv) {
  if (!argv[1]) return false;
  try {
    return realpathSync(argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

export function readStdin() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// One shape for both tools, holding only what the hooks read. `kind` is
// bash, read, search, edit, patch or other.
export function normalize(payload, tool) {
  const name = payload?.tool_name ?? '';
  const input = payload?.tool_input ?? {};
  const base = {
    tool,
    event: payload?.hook_event_name ?? '',
    cwd: payload?.cwd || process.cwd(),
    sessionId: typeof payload?.session_id === 'string' ? payload.session_id : '',
    transcriptPath: payload?.transcript_path ?? '',
    agentType: payload?.agent_type ?? '',
    prompt: typeof payload?.prompt === 'string' ? payload.prompt : '',
  };
  if (name === 'Bash' || name === 'shell' || name === 'exec_command' || name === 'local_shell') {
    const command = Array.isArray(input.command) ? input.command.join(' ') : String(input.command ?? input.cmd ?? '');
    return { ...base, kind: 'bash', command, paths: [] };
  }
  if (name === 'apply_patch') {
    const patch = String(input.command ?? input.patch ?? input.input ?? '');
    return { ...base, kind: 'patch', command: patch, paths: patchPaths(patch) };
  }
  if (name === 'Read') return { ...base, kind: 'read', command: '', paths: [input.file_path].filter(Boolean) };
  if (name === 'Glob') return { ...base, kind: 'search', command: '', paths: [input.path].filter(Boolean), glob: String(input.pattern ?? '') };
  if (name === 'Grep') return { ...base, kind: 'search', command: '', paths: [input.path].filter(Boolean), glob: String(input.glob ?? '') };
  if (EDIT_TOOLS.has(name)) return { ...base, kind: 'edit', command: '', paths: [input.file_path ?? input.notebook_path].filter(Boolean) };
  return { ...base, kind: 'other', command: '', paths: [] };
}

function patchPaths(patch) {
  const paths = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) paths.push((match[1] ?? match[2]).trim());
  return paths;
}

// Writes a PreToolUse answer. `allow` without a reason stays silent so the
// tool's own permission flow keeps running. Codex cannot ask, so an `ask`
// becomes a deny that hands the command to the maintainer.
export function respondPreToolUse(tool, verdict) {
  if (!verdict || verdict.decision === 'pass') return;
  let { decision, reason } = verdict;
  if (tool === 'codex') {
    if (decision === 'allow') return;
    if (decision === 'ask') reason = `${reason} Codex hooks cannot ask for confirmation, so this is blocked: give the maintainer the exact command and its effect, and let them run it.`;
    decision = 'deny';
  }
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } })}\n`);
}

export function respondContext(event, text) {
  if (!text) return;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } })}\n`);
}

// Reads a Claude or Codex transcript into an ordered list of
// { role: 'user' | 'assistant' | 'compaction', text }. Injected context,
// tool results and notifications are skipped. Unknown lines are ignored, so
// a format change degrades to "nothing found" rather than a crash.
export function readTranscript(path) {
  if (!path || !existsSync(path)) return [];
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    messages.push(...transcriptMessages(entry));
  }
  return messages;
}

function transcriptMessages(entry) {
  // Claude Code.
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') return [{ role: 'compaction', text: '' }];
  if ((entry.type === 'user' || entry.type === 'assistant') && entry.message) {
    if (entry.isMeta || entry.isSidechain || entry.isCompactSummary) return [];
    const text = contentText(entry.message.content, ['text']);
    if (!text) return [];
    if (entry.type === 'user' && isInjected(text)) return [];
    return [{ role: entry.type, text }];
  }
  // Codex.
  if (entry.type === 'compacted' || entry.payload?.type === 'context_compacted') return [{ role: 'compaction', text: '' }];
  if (entry.type === 'response_item' && entry.payload?.type === 'message') {
    const role = entry.payload.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const text = contentText(entry.payload.content, ['input_text', 'output_text']);
    if (!text || (role === 'user' && isInjected(text))) return [];
    return [{ role, text }];
  }
  return [];
}

function contentText(content, types) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && types.includes(part.type) && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

// Harness-injected user turns: task notifications, AGENTS.md, plugin lists.
const INJECTED = /^(?:<(?:task-notification|command-|local-command|system-reminder|recommended_plugins|environment_context|user_instructions|permissions|skill|user_shell_command|turn_aborted|bash-)|# AGENTS\.md|Caveat:)/;

function isInjected(text) {
  return INJECTED.test(text.trimStart());
}

// Only raising matters, so the patterns err toward finding a level: a false
// L1 or L2 costs a confirmation, a missed one opens the L0 merge.
const LEVEL_ANNOUNCED = /\b(?:Level|Niveau)[\s*_:]*(L[0-2])\b/gi;
const LEVEL_RAISED = /\b(?:rais(?:e|es|ed|ing)|now|bump(?:s|ed|ing)?|pass(?:e|es|er|ons)|mont(?:e|er|ons))\b[^.\n]{0,40}?\b(L[12]|niveau\s*[12])\b/gi;
const LEVEL_SET_BY_USER = /\b(?:level|niveau)\s*(?:is|est|to|en|à|a|:|=)?\s*[*_`]*(L[0-2])\b/gi;
const LEVEL_MENTIONED = /\b(L[12]|niveau\s*[12])\b/gi;

const PATTERNS = { assistant: [LEVEL_ANNOUNCED, LEVEL_RAISED], user: [LEVEL_SET_BY_USER, LEVEL_MENTIONED] };

// The effective level of the session: the highest level announced or raised
// by the assistant, or set or merely mentioned by the user. It only ever
// rises (design decision 16): to work at
// a lower level, start a new session. `null` when nothing was announced.
export function effectiveLevel(messages) {
  let level = null;
  for (const message of messages) {
    for (const pattern of PATTERNS[message.role] ?? []) {
      for (const match of message.text.matchAll(pattern)) {
        const value = Number(match[1].at(-1));
        level = level === null ? value : Math.max(level, value);
      }
    }
  }
  return level;
}

export const REQUEST_MIN_LENGTH = 80;

// The request being worked on: the latest user prompt long enough to carry a
// task. Short prompts ("yes", "go") answer the current request.
export function currentRequest(messages, prompt = '') {
  if (prompt.trim().length >= REQUEST_MIN_LENGTH && !isInjected(prompt)) return prompt.trim();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && message.text.trim().length >= REQUEST_MIN_LENGTH) return message.text.trim();
  }
  return prompt.trim();
}

export function truncate(text, limit) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

// Truncates to at most `maxBytes` of UTF-8, never splitting a character.
export function truncateBytes(text, maxBytes) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(flat) <= maxBytes) return flat;
  const budget = maxBytes - Buffer.byteLength('…');
  let kept = '';
  let bytes = 0;
  for (const character of flat) {
    const size = Buffer.byteLength(character);
    if (bytes + size > budget) break;
    kept += character;
    bytes += size;
  }
  return `${kept}…`;
}
