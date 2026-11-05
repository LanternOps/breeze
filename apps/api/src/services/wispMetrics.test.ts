import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { metricsRegistry } from './metricsRegistry';
import {
  incSpecialistRequest,
  incWispAssessment,
  incWispBudgetExhausted,
  incWispConcern,
  incWispGrantPause,
  incWispNudge,
  setWispGrantsActive,
} from './wispMetrics';

describe('wispMetrics', () => {
  it('registers the seven wisp_* series on metricsRegistry with the documented label sets', async () => {
    incSpecialistRequest('sweep', 'admitted');
    incWispGrantPause('budget_exhausted');
    incWispAssessment('admitted');
    incWispNudge('sent');
    incWispConcern('opened');
    incWispBudgetExhausted();
    setWispGrantsActive(3);
    const text = await metricsRegistry.metrics();
    expect(text).toMatch(/wisp_specialist_requests_total\{kind="sweep",outcome="admitted"\} 1/);
    expect(text).toMatch(/wisp_grant_pauses_total\{reason="budget_exhausted"\} 1/);
    expect(text).toMatch(/wisp_assessments_total\{outcome="admitted"\} 1/);
    expect(text).toMatch(/wisp_nudges_total\{result="sent"\} 1/);
    expect(text).toMatch(/wisp_concerns_total\{transition="opened"\} 1/);
    expect(text).toMatch(/wisp_grants_active 3/);
    for (const n of [
      'wisp_specialist_requests_total', 'wisp_grant_pauses_total', 'wisp_assessments_total',
      'wisp_nudges_total', 'wisp_concerns_total', 'wisp_budget_exhausted_total', 'wisp_grants_active',
    ]) expect(text).toContain(`# HELP ${n}`);
  });

  it('is a leaf module (imports only metricsRegistry)', () => {
    const src = readFileSync(join(__dirname, 'wispMetrics.ts'), 'utf8');
    const imports = src.match(/^import .* from '(.*)'/gm) ?? [];
    const nonProm = imports.filter((i) => !i.includes("'prom-client'"));
    expect(nonProm).toEqual([expect.stringContaining("'./metricsRegistry'")]);
  });
});
