#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, hash, hasText, head, id, jsonFile, options, read, stateRoot, update } from './store.mjs';

const key = (name) => `mission-${id(name)}`;
function existing(state) { if (!state) throw new Error('Unknown mission'); return state; }
function nonemptyList(value) { return Array.isArray(value) && value.length > 0 && value.every(hasText); }
function skillFile(repo, path) {
  if (!hasText(path) || isAbsolute(path) || path.split(/[\\/]/).includes('..') || !path.startsWith('.agents/skills/') || !path.endsWith('/SKILL.md')) throw new Error('Expected a canonical repository-relative skill path');
  const root = realpathSync(repo); const file = realpathSync(resolve(root, path));
  const rel = relative(root, file);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Skill escapes repository');
  return file;
}

export function begin(repo, root, input) {
  if (!hasText(input.summary) || !nonemptyList(input.acceptance) || !nonemptyList(input.scope) || !hasText(input.authorization?.reference) || !nonemptyList(input.authorization?.actions)) throw new Error('Mission requires summary, acceptance, scope and an explicit authorization reference/actions');
  if (!Array.isArray(input.skills) || !input.skills.every(hasText)) throw new Error('Declare applicable skill paths, including an explicit empty list when none apply');
  if (input.sessionIds !== undefined && (!Array.isArray(input.sessionIds) || !input.sessionIds.every(hasText))) throw new Error('Session references must be strings');
  for (const path of input.skills) skillFile(repo, path);
  return update(root, key(input.id), 0, () => ({
    id: input.id, summary: input.summary, acceptance: input.acceptance, scope: input.scope,
    authorization: input.authorization, requiredSkills: [...new Set(input.skills)],
    head: head(repo), status: 'active', remaining: [...input.acceptance], decisions: [],
    blockers: [], effects: {}, skills: {}, checks: [], sessionIds: input.sessionIds ?? [], orchestration: input.orchestration ?? null,
  }));
}

export function checkpoint(root, name, revision, patch) {
  const allowed = new Set(['remaining', 'decisions', 'blockers', 'status', 'sessionIds']);
  if (Object.keys(patch).some((field) => !allowed.has(field))) throw new Error('Mandate is immutable; a new authorization needs a new mission');
  return update(root, key(name), revision, (state) => {
    existing(state);
    if (patch.sessionIds !== undefined) {
      if (!Array.isArray(patch.sessionIds) || !patch.sessionIds.every(hasText)) throw new Error('Session references must be strings');
      state.sessionIds = [...new Set([...(state.sessionIds ?? []), ...patch.sessionIds])];
    }
    if (patch.remaining !== undefined) {
      if (!Array.isArray(patch.remaining) || !patch.remaining.every(hasText)) throw new Error('Invalid remaining work');
      state.remaining = patch.remaining;
    }
    for (const decision of patch.decisions ?? []) {
      if (!hasText(decision.id) || !hasText(decision.reference) || state.decisions.some((item) => item.id === decision.id)) throw new Error('Decisions must be new references, never overwritten');
      if (decision.supersedes && !state.decisions.some((item) => item.id === decision.supersedes)) throw new Error('Unknown superseded decision');
      state.decisions.push(decision);
    }
    if (patch.blockers !== undefined) {
      if (!Array.isArray(patch.blockers) || !patch.blockers.every((b) => hasText(b.reason) && hasText(b.owner) && nonemptyList(b.blocks) && hasText(b.nextAction))) throw new Error('Blockers need owner, affected work and next action');
      state.blockers = patch.blockers;
    }
    if (patch.status !== undefined) {
      if (!['active', 'paused', 'cancelled'].includes(patch.status)) throw new Error('Use finish to complete a mission');
      state.status = patch.status;
    }
    return state;
  });
}

export function deliverSkill(repo, root, name, revision, path) {
  const content = readFileSync(skillFile(repo, path), 'utf8');
  if (!content.trim()) throw new Error('Empty skill');
  const digest = hash(content);
  const state = update(root, key(name), revision, (state) => {
    existing(state);
    if (!state.requiredSkills.includes(path)) throw new Error('Skill not declared in mission');
    state.skills[path] = { digest, deliveredAt: new Date().toISOString(), stage: 'delivered' };
    return state;
  });
  return { revision: state.revision, path, digest, content };
}

export function applySkill(root, name, revision, input) {
  return update(root, key(name), revision, (state) => {
    existing(state); const skill = state.skills[input.path];
    if (!skill || input.digest !== skill.digest || !hasText(input.application)) throw new Error('Application must identify the delivered digest and observable work');
    state.skills[input.path] = { ...skill, stage: 'applied', application: input.application };
    return state;
  });
}

export function effect(root, name, revision, input) {
  id(input.id);
  if (!hasText(input.description) || !['prepared', 'confirmed', 'uncertain'].includes(input.status)) throw new Error('Invalid effect receipt');
  return update(root, key(name), revision, (state) => {
    existing(state); const prior = state.effects[input.id];
    if (!prior && (input.status !== 'prepared' || typeof input.replaySafe !== 'boolean')) throw new Error('Record intent and replay safety before an effect');
    if (prior && (input.description !== prior.description || input.status === 'prepared' || prior.status === 'confirmed' || (input.replaySafe !== undefined && input.replaySafe !== prior.replaySafe))) throw new Error('Do not duplicate or rewrite an effect intent');
    if (input.status !== 'prepared' && !hasText(input.evidence)) throw new Error('Effect outcome needs evidence');
    state.effects[input.id] = { ...prior, ...input };
    return state;
  });
}

export function resume(repo, root, name, revision) {
  return update(root, key(name), revision, (state) => {
    existing(state);
    if (state.status !== 'active') throw new Error('Explicitly reactivate a paused mission; cancelled/completed work is not resumed automatically');
    state.head = head(repo);
    state.recovery = Object.entries(state.effects).filter(([, item]) => item.status !== 'confirmed').map(([id, item]) => ({ id, action: item.replaySafe ? 'safe-to-retry-after-inspection' : 'reconcile-external-outcome' }));
    return state;
  });
}

export function verify(repo, root, name, revision, argv, { skill = null, timeout = 120000, execute = spawnSync } = {}) {
  if (!nonemptyList(argv) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600000) throw new Error('Verification requires argv and a bounded timeout');
  const state = existing(read(root, key(name)));
  if (state.revision !== revision || state.status !== 'active') throw new Error('Reload the active mission before running verification');
  if (skill && state.skills[skill]?.stage !== 'applied') throw new Error('Apply the delivered skill before verification');
  const before = head(repo);
  const cleanBefore = git(repo, ['status', '--porcelain', '--untracked-files=normal']) === '';
  const run = execute(argv[0], argv.slice(1), { cwd: repo, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, shell: false });
  const after = head(repo);
  const clean = git(repo, ['status', '--porcelain', '--untracked-files=normal']) === '';
  const passed = run.status === 0 && !run.error && before === after && clean && cleanBefore;
  return update(root, key(name), revision, (current) => {
    const receipt = { argv, head: before, pass: passed, exitCode: run.status, signal: run.signal ?? null,
      error: run.error?.message ?? null, clean, cleanBefore,
      output: (String(run.stdout ?? '') + String(run.stderr ?? '')).slice(-16000),
      outputDigest: hash(String(run.stdout ?? '') + String(run.stderr ?? '')), at: new Date().toISOString() };
    current.checks.push(receipt);
    if (skill && passed) current.skills[skill] = { ...current.skills[skill], stage: 'verified', head: before, check: current.checks.length - 1 };
    current.head = after;
    return current;
  });
}

export function completionFailures(repo, state) {
  existing(state); const actual = head(repo); const failures = [];
  if (git(repo, ['status', '--porcelain', '--untracked-files=normal'])) failures.push('Working tree is not clean');
  if (state.head !== actual || state.checks.at(-1)?.head !== actual || state.checks.at(-1)?.pass !== true) failures.push('Latest verification does not pass on current HEAD');
  if (state.remaining.length || state.blockers.length) failures.push('Remaining work or unresolved blockers');
  if (Object.values(state.effects).some((item) => item.status !== 'confirmed')) failures.push('Unreconciled effects');
  for (const path of state.requiredSkills) {
    const receipt = state.skills[path];
    if (receipt?.stage !== 'verified' || receipt.head !== actual || receipt.digest !== hash(readFileSync(skillFile(repo, path)))) failures.push(`Unverified skill application: ${path}`);
  }
  return failures;
}

export function finish(repo, root, name, revision) {
  return update(root, key(name), revision, (state) => {
    if (existing(state).status !== 'active') throw new Error('Only an active mission can finish');
    const failures = completionFailures(repo, state);
    if (failures.length) throw new Error(failures.join('; '));
    state.status = 'completed'; return state;
  });
}

export function main(args = process.argv.slice(2)) {
  const [command, ...flags] = args;
  if (!command || command === '--help') {
    console.log('mission.mjs begin|show|checkpoint|skill|applied|effect|resume|verify|check|finish --repo PATH --id ID [--revision N] [--file JSON] [--skill .agents/skills/NAME/SKILL.md] [--argv JSON] [--state-root PATH]'); return 0;
  }
  const o = options(flags, ['repo', 'state-root', 'revision', 'id', 'file', 'skill', 'argv']); const repo = resolve(o.repo || process.cwd()); const root = o['state-root'] || stateRoot(repo); const revision = Number(o.revision);
  let result;
  switch (command) {
    case 'begin': result = begin(repo, root, jsonFile(o.file)); break;
    case 'show': result = existing(read(root, key(o.id))); break;
    case 'checkpoint': result = checkpoint(root, o.id, revision, jsonFile(o.file)); break;
    case 'skill': result = deliverSkill(repo, root, o.id, revision, o.skill); break;
    case 'applied': result = applySkill(root, o.id, revision, jsonFile(o.file)); break;
    case 'effect': result = effect(root, o.id, revision, jsonFile(o.file)); break;
    case 'resume': result = resume(repo, root, o.id, revision); break;
    case 'verify': result = verify(repo, root, o.id, revision, JSON.parse(o.argv), { skill: o.skill }); break;
    case 'check': result = { failures: completionFailures(repo, read(root, key(o.id))) }; break;
    case 'finish': result = finish(repo, root, o.id, revision); break;
    default: throw new Error('Unknown mission command');
  }
  console.log(JSON.stringify(result, null, 2));
  return result.failures?.length || (command === 'verify' && !result.checks.at(-1).pass) ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
