// Framework view math (spec §14 W2; Open Decision 7). Pure: derives "evidence for N of M safeguards" from the
// public payload alone, so the portal and the tests share one definition. Never claims compliance: it counts
// safeguards that a shown control references and that were assessed (telemetry) or are currently declared.
import { FRAMEWORK_CROSSWALK, FRAMEWORK_META } from './frameworkCrosswalk';
import type { TrustFramework } from './types';
import type { TrustPagePublicPayload } from '../validators/trustCenter';

export interface FrameworkSafeguardRow {
  ref: string;
  label: string;
  ig: 1 | 2 | 3 | null;
  controls: Array<{ id: string; source: 'telemetry' | 'declared'; status: string; counts: boolean }>;
}
export interface FrameworkCoverage {
  framework: TrustFramework;
  total: number;
  evidenced: number;
  verified: number;
  declaredOnly: number;
  safeguards: FrameworkSafeguardRow[];
}

const naturalCompare = new Intl.Collator('en', { numeric: true }).compare;

export function summarizeFrameworkCoverage(payload: TrustPagePublicPayload, framework: TrustFramework): FrameworkCoverage {
  const rows = new Map<string, FrameworkSafeguardRow>();
  const evidenced = new Set<string>();
  const verified = new Set<string>();

  const add = (
    refs: ReadonlyArray<{ framework: TrustFramework; ref: string }>,
    control: { id: string; source: 'telemetry' | 'declared'; status: string; counts: boolean },
  ) => {
    for (const r of refs) {
      if (r.framework !== framework) continue;
      let row = rows.get(r.ref);
      if (!row) {
        const entry = FRAMEWORK_CROSSWALK[framework][r.ref];
        row = { ref: r.ref, label: entry?.label ?? r.ref, ig: entry?.ig ?? null, controls: [] };
        rows.set(r.ref, row);
      }
      row.controls.push({ ...control });
      if (control.counts) {
        evidenced.add(r.ref);
        if (control.source === 'telemetry') verified.add(r.ref);
      }
    }
  };

  for (const c of payload.controls) {
    add(c.frameworkRefs, { id: c.id, source: 'telemetry', status: c.status, counts: c.status !== 'not_assessed' });
  }
  for (const d of payload.declaredControls) {
    add(d.frameworkRefs, { id: d.id, source: 'declared', status: d.status, counts: d.status === 'current' });
  }

  return {
    framework,
    total: FRAMEWORK_META[framework].safeguardTotal,
    evidenced: evidenced.size,
    verified: verified.size,
    declaredOnly: evidenced.size - verified.size,
    safeguards: [...rows.values()].sort((a, b) => naturalCompare(a.ref, b.ref)),
  };
}
