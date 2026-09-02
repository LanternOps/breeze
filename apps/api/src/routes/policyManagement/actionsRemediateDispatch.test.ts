import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// #3416: POST /policies/:id/remediate inserted a 'running' automation run and
// returned "Remediation automation triggered" without ever dispatching, so the
// row sat running forever and no script executed. Third site of the #3413
// class; the two policy-evaluation sites were fixed in #3414.
//
// This is a STRUCTURAL pin, and the limitation is worth stating: the fix is a
// single call site inside a long Hono handler that would need the whole
// auth + permission + org-check + db stack stood up to drive end to end, and a
// fully mocked version of that stack would assert my mocks rather than the
// route. Pinning the source shape instead is narrow but honest — it fails if
// the dispatch is removed, moved before the insert, or given a target argument
// it must not have. A behavioural test belongs with the integration suite that
// already stands up this router.

describe('manual policy remediation dispatches the run it creates (#3416)', () => {
  it('dispatches the inserted run, after the insert, with no target argument', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, 'actions.ts'), 'utf8');

    // dispatched at all
    expect(src).toContain("await import('../../jobs/automationWorker')");
    expect(src).toContain('await enqueueAutomationRun(run.id);');

    // ordered after the run insert — dispatching a row that does not exist yet
    // would throw inside the runtime rather than remediate anything
    const insertIdx = src.indexOf('.insert(automationRuns)');
    const dispatchIdx = src.indexOf('await enqueueAutomationRun(run.id);');
    expect(insertIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(insertIdx);

    // and NOT narrowed to a device list: this route remediates the policy's own
    // target set, so the runtime must resolve targets from the automation
    expect(src).not.toMatch(/enqueueAutomationRun\(run\.id,\s*\[/);
  });

  it('rejects a managed automation after resolving it and before creating a run', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, 'actions.ts'), 'utf8');

    const notFoundIdx = src.indexOf('Remediation automation not found for this organization');
    const managedGuardIdx = src.indexOf('isManagedAutomation(automation)');
    const insertIdx = src.indexOf('.insert(automationRuns)', notFoundIdx);

    expect(notFoundIdx).toBeGreaterThan(-1);
    expect(managedGuardIdx).toBeGreaterThan(notFoundIdx);
    expect(insertIdx).toBeGreaterThan(managedGuardIdx);
  });
});
