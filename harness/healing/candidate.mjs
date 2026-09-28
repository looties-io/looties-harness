#!/usr/bin/env node
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDocuments, readDocument, writeDocument } from '../hooks/journal.mjs';
import { existingGuidance, forbiddenPathReasons, hiddenTextReasons, looseningReasons, ruleTextReasons } from './lint.mjs';
import { CANDIDATE_TYPES, LIMITS, neverTouchPaths, repoRoot, slug } from './lib.mjs';

// The only write a self-healing run makes: it proposes a candidate, which
// lands in the agent journal (candidates/<id>.json) with its lint result.
// Nothing reaches the repository until the maintainer closes the candidate's issue
// as completed. Usage:
//   node .agents/healing/candidate.mjs add < candidate.json
//   node .agents/healing/candidate.mjs list [status]
// Owned by docs/agent-harness.md#self-healing-loop.

const STATUSES = new Set(['lint-failed', 'drafted', 'canary-failed', 'ready', 'published', 'admitted', 'rejected', 'applied', 'retired']);

/**
 * Validates and lints a proposal. `input` holds type (rule, skill or
 * loosening), title, why, evidence (event keys or URLs), and per type:
 * rule: body and optional paths; skill: skill and proposal; loosening:
 * protection, proposal and the friction or breakage that justifies it.
 */
const CONTROL = /[\u0000-\u001f\u007f]/;

export function buildCandidate(input, { now = new Date(), root = repoRoot, guidance = existingGuidance(root) } = {}) {
  const errors = [];
  const type = input?.type;
  if (!CANDIDATE_TYPES.includes(type)) errors.push(`type must be one of ${CANDIDATE_TYPES.join(', ')}`);
  for (const key of ['title', 'why']) if (typeof input?.[key] !== 'string' || !input[key].trim()) errors.push(`${key} is required`);
  if (!Array.isArray(input?.evidence) || input.evidence.length === 0) errors.push('evidence must list at least one journal event key or URL');
  // Single-line fields land in frontmatter and issue lines: a line break
  // there could smuggle text into an admitted rule.
  const singleLine = [input?.title, ...(Array.isArray(input?.evidence) ? input.evidence : []), input?.skill, input?.protection, ...(Array.isArray(input?.targets) ? input.targets : []), ...(Array.isArray(input?.paths) ? input.paths : [])];
  if (singleLine.some((value) => value !== undefined && (typeof value !== 'string' || CONTROL.test(value)))) errors.push('title, evidence, skill, protection, targets and paths must be single-line strings');
  const hidden = [...new Set([...singleLine, input?.why, input?.body, input?.proposal].filter((value) => typeof value === 'string').flatMap(hiddenTextReasons))];
  if (hidden.length > 0) errors.push(`a field ${hidden.join('; ')}`);
  if (type === 'rule' && (typeof input.body !== 'string' || !input.body.trim())) errors.push('a rule needs body');
  if (type === 'skill' && (!/^[a-z0-9][a-z0-9-]*$/.test(input.skill ?? '') || !input.proposal)) errors.push('a skill candidate needs skill (a kebab-case name) and proposal');
  if (type === 'loosening' && (!input.protection || !input.proposal || !['broken-feature', 'recurring-friction'].includes(input.justification))) errors.push('a loosening candidate needs protection, proposal and justification (broken-feature or recurring-friction)');
  if (errors.length > 0) return { errors };

  const text = type === 'rule' ? input.body.trim() : String(input.proposal).trim();
  const reasons = [];
  if (type === 'rule') reasons.push(...ruleTextReasons(text, guidance, root));
  // A rule's title names its file, which the anchor loads with the rule.
  if (type === 'rule') reasons.push(...looseningReasons(input.title).map((reason) => `title ${reason}`), ...forbiddenPathReasons(input.title, root).map((reason) => `title ${reason}`));
  // A skill proposal may say anything about its own skill, but never loosen a
  // safeguard or target a path the loop never touches.
  if (type === 'skill') reasons.push(...looseningReasons(text), ...forbiddenPathReasons(text, root));
  if (type === 'skill' && neverTouchPaths(root).some((prefix) => (input.targets ?? []).some((target) => String(target).startsWith(prefix)))) reasons.push('targets a path the loop never touches');
  // A loosening proposal loosens by definition; it is only ever a proposal,
  // implemented by a normal L2 change once the maintainer accepts it.
  if (type === 'loosening' && input.justification === 'recurring-friction' && (input.evidence.length < LIMITS.frictionEvents)) reasons.push(`recurring friction needs at least ${LIMITS.frictionEvents} blocking events within ${LIMITS.frictionWindowDays} days`);

  const id = `${now.toISOString().slice(0, 10)}-${slug(input.title)}-${createHash('sha256').update(`${type}\n${text}`).digest('hex').slice(0, 6)}`;
  return {
    candidate: {
      id,
      type,
      title: input.title.trim(),
      why: input.why.replace(/\s+/g, ' ').trim(),
      evidence: input.evidence.map(String),
      ...(type === 'rule' ? { body: text, paths: Array.isArray(input.paths) ? input.paths.map(String) : [] } : {}),
      ...(type === 'skill' ? { skill: input.skill, proposal: text, targets: (input.targets ?? []).map(String), newSkill: Boolean(input.newSkill) } : {}),
      ...(type === 'loosening' ? { protection: String(input.protection), proposal: text, justification: input.justification } : {}),
      status: reasons.length > 0 ? 'lint-failed' : 'drafted',
      lint: reasons,
      createdAt: now.toISOString(),
      history: [{ at: now.toISOString(), status: reasons.length > 0 ? 'lint-failed' : 'drafted' }],
    },
  };
}

export function saveCandidate(candidate, options) {
  return writeDocument(`candidates/${candidate.id}.json`, candidate, options);
}

export function loadCandidate(id, options) {
  return readDocument(`candidates/${id}.json`, options);
}

export function listCandidates(status = null, options) {
  return listDocuments('candidates', options).filter((candidate) => !status || candidate.status === status);
}

/** Moves a candidate to `status`, keeping its history. */
export function setStatus(candidate, status, extra = {}, { now = new Date(), ...options } = {}) {
  if (!STATUSES.has(status)) throw new Error(`unknown candidate status ${status}`);
  const next = { ...candidate, ...extra, status, history: [...(candidate.history ?? []), { at: now.toISOString(), status, ...(extra.note ? { note: extra.note } : {}) }] };
  saveCandidate(next, options);
  return next;
}

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return JSON.parse(raw);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2);
  if (command === 'add') {
    const { errors, candidate } = buildCandidate(await readInput());
    if (errors) {
      console.error(`candidate rejected: ${errors.join('; ')}`);
      process.exit(1);
    }
    saveCandidate(candidate);
    console.log(JSON.stringify({ id: candidate.id, status: candidate.status, lint: candidate.lint }));
  } else if (command === 'list') {
    for (const candidate of listCandidates(argument ?? null)) console.log(`${candidate.status}\t${candidate.type}\t${candidate.id}\t${candidate.title}`);
  } else {
    console.error('usage: candidate.mjs add < candidate.json | candidate.mjs list [status]');
    process.exit(2);
  }
}
