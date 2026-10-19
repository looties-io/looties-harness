// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { runCanaries } from '../harness/healing/canary.mjs';

const candidate = { id: 'candidate', type: 'rule', body: 'Use the canonical owner.' };
const safety = { id: 'protected' };
const heldout = { id: 'historical-counterexample', purpose: 'benefit', heldOut: true };
const run = (cases, runner) => runCanaries({ candidate, cases, root: '/nonexistent/evaluation-fixture', ref: 'fixed-revision', runner });

describe('comparative evidence', () => {
  it('rejects empty suites and all-green no-benefit runs', async () => {
    expect(await run([], async () => ({ pass: true }))).toMatchObject({ verdict: 'inconclusive', eligible: false });
    expect(await run([safety, heldout], async () => ({ pass: true }))).toMatchObject({ verdict: 'pass', benefit: 'unproven', eligible: false });
  });
  it('requires repeated held-out improvement alongside protected behavior', async () => {
    const calls = [];
    const report = await run([safety, heldout], async (c, options) => {
      calls.push({ id: c.id, ref: options.ref, candidate: options.rules.includes('candidate') });
      return { pass: c.id === 'protected' || options.rules.includes('candidate') };
    });
    expect(report).toMatchObject({ verdict: 'pass', benefit: 'demonstrated', eligible: true });
    expect(calls).toHaveLength(6); expect(new Set(calls.map((c) => c.ref)).size).toBe(1);
  });
  it('does not count an infrastructure failure or training case as improvement', async () => {
    const runner = async (c, o) => ({ pass: c.id === 'protected' || o.rules.includes('candidate'), infrastructure: c.id !== 'protected' && !o.rules.includes('candidate') });
    expect((await run([safety, heldout], runner)).eligible).toBe(false);
    expect((await run([safety, { ...heldout, heldOut: false }], async (c, o) => ({ pass: c.id === 'protected' || o.rules.includes('candidate') }))).eligible).toBe(false);
  });
  it('does not trade a safety regression for a benefit', async () => {
    const report = await run([safety, heldout], async (c, o) => ({ pass: c.id === 'protected' ? !o.rules.includes('candidate') : o.rules.includes('candidate') }));
    expect(report).toMatchObject({ verdict: 'fail', benefit: 'demonstrated', eligible: false });
  });
});
