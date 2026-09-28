#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEARNED_DIRECTORY, LIMITS, addDays, isoDate, neverTouchPaths, parseFrontmatter, repoRoot } from './lib.mjs';

// Deterministic lints of the self-healing loop: they run on every candidate
// before a canary spends a minute on it, and on every admitted rule in
// `node .agents/healing/lint.mjs`. A rule may only tighten: dedupe, size caps, the
// never-touch paths and the no-loosening check are what keep it that way.
// Owned by docs/agent-harness.md#self-healing-loop.

const STOPWORDS = new Set('the and for with that this from into when then than your you are not never always before after only each every any its their them they have has was were will would should must can may use run via per its our out off one two also but all any'.split(' '));

export function tokens(text) {
  return new Set(String(text).toLowerCase().replace(/`[^`]*`/g, (code) => code.replace(/[^a-z0-9]+/g, ' ')).split(/[^a-z0-9]+/).filter((word) => word.length >= 3 && !STOPWORDS.has(word)));
}

export function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const sentences = (text) => String(text).split(/(?<=[.!?;])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
const NEGATION = /\b(?:never|not|no|don't|do not|must not|cannot|can't|without exception|refuse|reject|deny|forbid(?:den)?|jamais|ne\s+\w+\s+pas)\b/i;

// Terms that weaken a safeguard unless the sentence forbids them.
const RISKY_TERMS = [
  /--no-verify\b/i,
  /--admin\b/i,
  /\bgit add (?:-A|--all|\.(?:\s|$))/i,
  /\bforce[- ]push|\bpush\s+(?:-f|--force)\b/i,
  /\bbypass/i,
  /\bskip(?:s|ped|ping)?\b/i,
  /\bdisabl(?:e|es|ed|ing)\b/i,
  /\bturn(?:s|ed|ing)? off\b/i,
  /eslint-disable|@ts-(?:ignore|nocheck|expect-error)/i,
  /\b(?:it|describe|test)\.(?:skip|only)\b|\bxit\(/i,
  /continue-on-error|--passWithNoTests/i,
  /\blower(?:s|ed|ing)? the level\b|\bdrop(?:s|ped)? to L[01]\b/i,
];
// Phrases that remove a duty whatever the sentence says around them.
const LOOSENING_PHRASES = [
  /\b(?:without|no need to|need not|needn't|don't need to|do not need to)\s+(?:ask|asking|confirm|confirming|review|reviewing|a review|test|testing|run(?:ning)? (?:the )?(?:tests|checks|verify|hooks))/i,
  /\b(?:do not|don't|never)\s+(?:ask|confirm|wait for|run the (?:tests|checks|hooks)|review)\b/i,
  /\b(?:make|mark|treat|consider)s?\b[^.]{0,40}\b(?:optional|advisory|non-blocking)\b/i,
  /\bignor(?:e|es|ed|ing)\b[^.]{0,30}\b(?:lint|tests?|checks?|guard|hooks?|review|warnings?|failures?)\b/i,
];
const EDIT_VERB = /\b(?:edit|change|modify|update|write|rewrite|add (?:to|a|an)|remove|delete|append|patch|touch)\b/i;

/** Why `text` could loosen a safeguard, one reason per hit. */
// What the maintainer reads on GitHub must be what the loop applies: HTML (comments
// included), invisible or direction characters and Markdown link definitions
// render as nothing, so a candidate may not contain them.
// An allowlist, not a denylist: printable ASCII, Latin letters with
// diacritics, typographic quotes and line breaks. Everything else (invisible,
// tag, direction, variation or filler characters) may render as nothing.
const ALLOWED_CHARACTERS = /^[\x20-\x7e\n\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u017f\u2018\u2019\u201c\u201d]*$/;
const HIDDEN_TEXT = [
  [(text) => !ALLOWED_CHARACTERS.test(text), 'contains a character outside the allowed set (invisible, direction or other characters GitHub may not show)'],
  [(text) => /[<>]/.test(text), 'contains < or >, which GitHub may render as hidden HTML'],
  [(text) => /[$\\]/.test(text), 'contains $ or a backslash, which GitHub may render as math or an escape'],
  [(text) => /!\[|\]\(|^ {0,3}\[[^\]]*\]:|&#?[A-Za-z0-9]+;/m.test(text), 'contains an image, a link, a link definition or an HTML entity, which GitHub renders without its text'],
];

export function hiddenTextReasons(text) {
  const value = String(text ?? '');
  return HIDDEN_TEXT.filter(([test]) => test(value)).map(([, reason]) => reason);
}

export function looseningReasons(text) {
  const reasons = [];
  for (const sentence of sentences(text)) {
    for (const pattern of LOOSENING_PHRASES) if (pattern.test(sentence)) reasons.push(`removes a duty: "${sentence.slice(0, 120)}"`);
    for (const pattern of RISKY_TERMS) {
      const match = pattern.exec(sentence);
      if (match && !NEGATION.test(sentence.slice(0, match.index))) reasons.push(`uses "${match[0].trim()}" without forbidding it: "${sentence.slice(0, 120)}"`);
    }
  }
  return [...new Set(reasons)];
}

/** Never-touch paths (the harness's and the repository's) the text tells an agent to change. */
export function forbiddenPathReasons(text, root = repoRoot) {
  const reasons = [];
  const paths = neverTouchPaths(root);
  for (const sentence of sentences(text)) {
    if (!EDIT_VERB.test(sentence) || NEGATION.test(sentence)) continue;
    const hit = paths.find((prefix) => sentence.includes(prefix));
    if (hit) reasons.push(`tells an agent to change ${hit}, which the loop never touches: "${sentence.slice(0, 120)}"`);
  }
  return reasons;
}

export function sizeReasons(body) {
  const text = body.trim();
  const reasons = [];
  const lines = text.split('\n').length;
  const bytes = Buffer.byteLength(text);
  if (!text) reasons.push('is empty');
  if (lines > LIMITS.ruleBodyLines) reasons.push(`has ${lines} lines, over the ${LIMITS.ruleBodyLines}-line cap`);
  if (bytes > LIMITS.ruleBodyBytes) reasons.push(`has ${bytes} bytes, over the ${LIMITS.ruleBodyBytes}-byte cap`);
  return reasons;
}

/** Existing always-loaded guidance a new rule must not repeat: base rule items, instinct steps, admitted rules. */
export function existingGuidance(root = repoRoot, { exclude = null } = {}) {
  const items = [];
  const base = path.join(root, '.agents/rules/base.md');
  if (existsSync(base)) for (const line of readFileSync(base, 'utf8').split('\n')) if (/^\d+\.\s/.test(line)) items.push({ source: '.agents/rules/base.md', text: line });
  const instincts = path.join(root, '.agents/instincts');
  if (existsSync(instincts)) {
    for (const name of readdirSync(instincts).filter((file) => file.endsWith('.md'))) {
      for (const line of parseFrontmatter(readFileSync(path.join(instincts, name), 'utf8')).body.split('\n')) if (/^\d+\.\s/.test(line)) items.push({ source: `.agents/instincts/${name}`, text: line });
    }
  }
  for (const rule of learnedRuleFiles(root)) if (rule.file !== exclude) items.push({ source: rule.file, text: rule.body });
  return items;
}

export function duplicateReasons(body, guidance) {
  return guidance
    .map((item) => ({ ...item, score: similarity(body, item.text) }))
    .filter(({ score }) => score >= LIMITS.duplicateSimilarity)
    .map(({ source, score }) => `repeats ${source} (similarity ${score.toFixed(2)})`);
}

/** Every reason a rule body cannot be admitted. */
export function ruleTextReasons(body, guidance = [], root = repoRoot) {
  return [...sizeReasons(body), ...looseningReasons(body), ...forbiddenPathReasons(body, root), ...duplicateReasons(body, guidance)];
}

export function learnedRuleFiles(root = repoRoot) {
  const directory = path.join(root, LEARNED_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => {
      const file = `${LEARNED_DIRECTORY}/${name}`;
      const { data, body } = parseFrontmatter(readFileSync(path.join(root, file), 'utf8'));
      return { file, name: name.replace(/\.md$/, ''), data, body: body.trim() };
    });
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** { failures, warnings } for the admitted rules; failures block the harness check. */
export function checkLearnedRules(root = repoRoot, { today = new Date() } = {}) {
  const failures = [];
  const warnings = [];
  const rules = learnedRuleFiles(root);
  if (rules.length > LIMITS.activeRules) failures.push(`${LEARNED_DIRECTORY}: ${rules.length} active rules, over the cap of ${LIMITS.activeRules}; retire some before admitting more`);
  const total = rules.reduce((sum, rule) => sum + Buffer.byteLength(rule.body), 0);
  if (total > LIMITS.learnedTotalBytes) failures.push(`${LEARNED_DIRECTORY}: ${total} bytes of rules, over the ${LIMITS.learnedTotalBytes}-byte budget the anchor loads`);
  for (const rule of rules) {
    const where = rule.file;
    const data = rule.data;
    if (!data) {
      failures.push(`${where}: needs frontmatter (name, description, admitted, reviewAfter, issue, record, evidence)`);
      continue;
    }
    if (data.name !== rule.name) failures.push(`${where}: frontmatter name must be ${rule.name}`);
    for (const key of ['description', 'issue', 'record']) if (!data[key]) failures.push(`${where}: frontmatter needs ${key}`);
    if (!Array.isArray(data.evidence) || data.evidence.length === 0) failures.push(`${where}: frontmatter needs a non-empty evidence list`);
    if (!DATE.test(data.admitted ?? '')) failures.push(`${where}: frontmatter needs admitted: YYYY-MM-DD`);
    if (!DATE.test(data.reviewAfter ?? '')) failures.push(`${where}: frontmatter needs reviewAfter: YYYY-MM-DD`);
    // A kept rule records its renewal; the cap runs from the latest of the two.
    const since = [data.admitted, data.renewed].filter((value) => DATE.test(value ?? '')).sort().at(-1);
    if (data.renewed !== undefined && !DATE.test(data.renewed)) failures.push(`${where}: renewed must be YYYY-MM-DD`);
    if (since && DATE.test(data.reviewAfter ?? '') && data.reviewAfter > isoDate(addDays(new Date(`${since}T00:00:00Z`), LIMITS.reviewMaxDays))) failures.push(`${where}: reviewAfter is more than ${LIMITS.reviewMaxDays} days after ${since === data.admitted ? 'admitted' : 'renewed'}`);
    if (DATE.test(data.reviewAfter ?? '') && data.reviewAfter < isoDate(today)) warnings.push(`${where}: review date ${data.reviewAfter} has passed; the nightly pass opens a retire-or-keep issue`);
    if (data.record && !existsSync(path.join(root, data.record))) failures.push(`${where}: record ${data.record} does not exist`);
    for (const reason of ruleTextReasons(rule.body, existingGuidance(root, { exclude: rule.file }), root)) failures.push(`${where}: ${reason}`);
  }
  return { failures, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { failures, warnings } = checkLearnedRules();
  for (const warning of warnings) console.warn(`[healing lint] warning: ${warning}`);
  if (failures.length > 0) {
    console.error(`[healing lint] ${failures.length} failure(s):\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`[healing lint] OK (${learnedRuleFiles().length} learned rules)`);
}
