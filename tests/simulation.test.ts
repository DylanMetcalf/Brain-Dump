import { describe, it, expect } from 'vitest';
import { runSimulation } from '../src/sim/simulation.js';

describe('30-day simulation (spec §70)', () => {
  it('removes mental load without errors, false claims, duplicates or lost thoughts', async () => {
    const r = await runSimulation();
    if (r.failures.length) console.log(r.failures);
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(r.checks);
    expect(r.falseClaims).toBe(0);
    expect(r.duplicates).toBe(0);
    expect(r.thoughtsLost).toBe(0);
    expect(r.unnecessaryConfirmations).toBe(0);
    expect(r.verifiedActions).toBeGreaterThan(50);
    // Far more work done than questions asked.
    expect(r.verifiedActions / Math.max(1, r.questionsAsked)).toBeGreaterThan(3);
  });
});
