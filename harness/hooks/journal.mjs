import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { LOOP_ENV } from './config.mjs';

// The agent journal (design decision 23): the raw record the self-healing
// loop learns from. Guard verdicts, session summaries, the interpretation
// ledger, candidate rules and canary runs live outside the repository, in a
// directory that .agents/healing/journal-sync.mjs can push to a private
// repository (`journalRepository` in the config) so the evidence survives the
// loss of a machine. Only hooks and the self-healing scripts write it; the
// guard denies agents any direct write. Owned by
// docs/agent-harness.md#self-healing-loop.

export const JOURNAL_DIRECTORY = 'agent-journal';
const STREAMS = new Set(['events', 'ledger']);

/** The journal: $HARNESS_JOURNAL_DIR, else $XDG_STATE_HOME (or ~/.local/state)/agent-journal. */
export function journalRoot(env = process.env) {
  if (env.HARNESS_JOURNAL_DIR) return resolve(env.HARNESS_JOURNAL_DIR);
  const state = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state');
  return join(state, JOURNAL_DIRECTORY);
}

/**
 * True inside the loop's own runs (canaries, the healer, the nightly
 * sessions): their hooks record nothing, or the loop would learn from its
 * own test runs. The loop's scripts still write their documents.
 */
export function journalMuted(env = process.env) {
  return Object.values(LOOP_ENV).some((name) => env[name] === '1');
}

/** True when `absolute` is the journal or inside it. */
export function inJournal(absolute, env = process.env) {
  const root = journalRoot(env);
  const path = resolve(absolute);
  return path === root || path.startsWith(`${root}${sep}`);
}

// Secrets that can reach a command line or a pasted prompt. The journal is
// private, but it is still a copy: nothing that authenticates goes into it.
const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\bwhsec_[A-Za-z0-9]{8,}/g,
  /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bsbp_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
const SECRET_ASSIGNMENT = /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi;

export function redact(text) {
  let clean = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) clean = clean.replace(pattern, '[redacted]');
  return clean.replace(SECRET_ASSIGNMENT, '$1=[redacted]');
}

// Strings are redacted recursively, so no field can carry a secret through.
export function redactRecord(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactRecord);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactRecord(item)]));
  return value;
}

const machine = () => hostname().split('.')[0].replace(/[^A-Za-z0-9_-]/g, '-') || 'machine';

/**
 * Appends one record to a stream (`events` or `ledger`). Each machine writes
 * its own monthly file, so two machines never conflict when the journal syncs.
 */
export function appendRecord(stream, record, { env = process.env, now = new Date() } = {}) {
  if (!STREAMS.has(stream)) throw new Error(`unknown journal stream ${stream}`);
  const file = join(journalRoot(env), stream, `${now.toISOString().slice(0, 7)}.${machine()}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(redactRecord({ at: now.toISOString(), ...record }))}\n`);
  return file;
}

/** Every record of a stream, across machines and months, oldest file first; `since` filters on `at`. */
export function readRecords(stream, { env = process.env, since = null } = {}) {
  const directory = join(journalRoot(env), stream);
  if (!existsSync(directory)) return [];
  const records = [];
  for (const name of readdirSync(directory).filter((file) => file.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(directory, name), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!since || record.at >= since) records.push(record);
      } catch {
        // A torn line from a crash is skipped, never fatal.
      }
    }
  }
  return records.sort((left, right) => String(left.at).localeCompare(String(right.at)));
}

/** Writes a JSON document atomically under the journal (sessions/, candidates/, canaries/, state/). */
export function writeDocument(relativePath, value, { env = process.env } = {}) {
  const file = join(journalRoot(env), relativePath);
  if (!inJournal(file, env)) throw new Error(`${relativePath} escapes the journal`);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(redactRecord(value), null, 2)}\n`);
  renameSync(temporary, file);
  return file;
}

export function readDocument(relativePath, { env = process.env } = {}) {
  try {
    return JSON.parse(readFileSync(join(journalRoot(env), relativePath), 'utf8'));
  } catch {
    return null;
  }
}

export function listDocuments(relativeDirectory, { env = process.env } = {}) {
  const directory = join(journalRoot(env), relativeDirectory);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.json')).sort().map((name) => readDocument(join(relativeDirectory, name), { env })).filter(Boolean);
}
