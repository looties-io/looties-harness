import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { redactRecord } from '../hooks/journal.mjs';

export const hash = (data) => createHash('sha256').update(data).digest('hex');
export const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const head = (repo) => git(repo, ['rev-parse', 'HEAD']);
export const isSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
export function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid identifier');
  return value;
}

export function stateRoot(repo) {
  const common = realpathSync(git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'lstack', hash(common).slice(0, 24));
}

function inspect(file) {
  try { return lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function checkedPath(root, key) {
  const file = resolve(root, `${id(key)}.json`);
  let current = parse(file).root;
  for (const part of file.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const info = inspect(current);
    if (info?.isSymbolicLink() || (info?.isFile() && info.nlink !== 1)) throw new Error('State cannot traverse symbolic or hard links');
  }
  return file;
}

export function read(root, key) {
  const file = checkedPath(root, key);
  if (!inspect(file)) return null;
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('Corrupt state revision');
  return value;
}

export function update(root, key, revision, transform) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('An expected revision is required');
  const file = checkedPath(root, key);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`State locked: ${lock}. Reconcile its owner; never steal a lock by age.`); throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), key })}\n`, { flag: 'wx', mode: 0o600 });
    const previous = read(root, key);
    if ((previous?.revision ?? 0) !== revision) throw new Error('Revision conflict: reload before updating');
    const result = transform(previous);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Update must return state');
    const next = redactRecord({ ...result, revision: revision + 1, updatedAt: new Date().toISOString() });
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
    const parent = openSync(dirname(file), 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return next;
  } finally {
    if (inspect(temporary)) unlinkSync(temporary);
    if (inspect(join(lock, 'owner.json'))) unlinkSync(join(lock, 'owner.json'));
    rmdirSync(lock);
  }
}

export function options(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!/^--[a-z-]+$/.test(args[i]) || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error('Options require named values');
    const key = args[i].slice(2);
    if (allowed && !allowed.includes(key)) throw new Error(`Unknown option: ${key}`);
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate option: ${key}`);
    result[key] = args[i + 1];
  }
  return result;
}

export const jsonFile = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Read-only bridge to the existing session journal; missing linkage never means a skill was unused.
export function missionEvidence(repo, sessionId, root = null) {
  try {
    root ??= stateRoot(repo);
    if (!inspect(root)) return { status: 'no-linked-mission', missions: [] };
    const missions = readdirSync(root).filter((name) => /^mission-[a-zA-Z0-9_-]+\.json$/.test(name))
      .map((name) => read(root, name.slice(0, -5)))
      .filter((state) => state.sessionIds?.includes(sessionId))
      .map((state) => ({ id: state.id, revision: state.revision, status: state.status, head: state.head,
        skills: state.requiredSkills.map((path) => ({ path, ...(state.skills[path] ?? { stage: 'requested' }) })),
        latestCheck: state.checks.at(-1) ? { head: state.checks.at(-1).head, pass: state.checks.at(-1).pass } : null }));
    return { status: missions.length ? 'linked' : 'no-linked-mission', missions };
  } catch { return { status: 'unavailable', missions: [] }; }
}
