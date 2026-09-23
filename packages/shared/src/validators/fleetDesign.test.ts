import { describe, expect, it } from 'vitest';
import {
  fleetDesignSubmissionSchema,
  fleetDesignOutcomeFromSubmission,
  renderFleetDesignMarkdown,
  triggerFleetDesignRunSchema,
  fleetDesignRuleSchema,
  type FleetDesignOutcomeRefs,
} from './fleetDesign';
import { FLEET_DESIGN_SECTION_KEYS, FLEET_DESIGN_CONFIDENCE_THRESHOLD, type FleetDesignSubmission } from '../types/fleetDesign';

// validSubmission() is intentionally loosely typed (inferred, not annotated
// FleetDesignSubmission) so the negative-path tests below can mutate fields to
// deliberately invalid values (e.g. an unknown functionKey) without fighting
// the strict union types those fields carry in the real type. Call sites that
// feed a (presumed-valid) submission into fleetDesignOutcomeFromSubmission —
// which is typed strictly, since real callers always pass a zod-parsed value —
// cast at the boundary instead.
const asSubmission = (s: ReturnType<typeof validSubmission>) => s as unknown as FleetDesignSubmission;

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';

function validSubmission() {
  return {
    found: {
      summary: ['12 devices across 2 sites.'],
      findings: [{ title: 'Shared local admin on 4 workstations', deviceCount: 4, evidence: ['posture:localAdmin'] }],
    },
    functions: [
      { functionKey: 'file_server', deviceIds: [D1], confidence: 0.9, evidence: ['SMB listener; 2 TB data volume'] },
    ],
    monitoring: [
      {
        functionKey: 'file_server',
        watches: [{ watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'SMB is the function.' }],
        alertRules: [{
          name: 'File server disk over 85%', severity: 'high',
          kind: 'disk',
          condition: { operator: 'gt', value: 85, durationMinutes: 15 },
          responses: [], deliveryMode: 'inherit', deliveryChannelIds: [],
          cooldownMinutes: 60, rationale: 'Data volume growth is the failure mode.', action: 'none', paging: 'business_hours',
        }],
      },
    ],
    retired: [],
    automation: [{ functionKey: 'file_server', playbooks: [{ builtInName: 'Restart stopped service' }], scripts: [] }],
    legacy: [],
    baseline: { notes: ['Alert rate is dominated by disk warnings.'] },
    unsure: {
      lowConfidenceFunctions: [{ functionKey: 'kiosk', deviceIds: [D2], confidence: 0.4, evidence: ['single logon user'] }],
      unreachableDevices: [], needsHuman: [], roleCorrections: [],
    },
  };
}

const refs: FleetDesignOutcomeRefs = {
  deviceIds: new Set([D1, D2]),
  baseline: { alertsPer100EndpointsPerMonth: 42, ticketsPerMonth: 7, precursors: [{ condition: 'disk_used_over_threshold', deviceCount: 3 }] },
  generatedAt: '2026-09-12T00:00:00.000Z',
};

describe('fleetDesignSubmissionSchema', () => {
  it('accepts a valid submission', () => {
    expect(fleetDesignSubmissionSchema.safeParse(validSubmission()).success).toBe(true);
  });
  it('rejects a watch without a rationale, naming the path', () => {
    const s = validSubmission();
    (s.monitoring[0]!.watches[0] as { rationale?: string }).rationale = '';
    const r = fleetDesignSubmissionSchema.safeParse(s);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues[0]!.path)).toContain('rationale');
  });
  it('rejects a function below the confidence threshold', () => {
    const s = validSubmission();
    s.functions[0]!.confidence = FLEET_DESIGN_CONFIDENCE_THRESHOLD - 0.01;
    expect(fleetDesignSubmissionSchema.safeParse(s).success).toBe(false);
  });
  it('rejects an unknown function key and accepts a labelled custom key', () => {
    const s = validSubmission();
    s.functions[0]!.functionKey = 'toaster';
    expect(fleetDesignSubmissionSchema.safeParse(s).success).toBe(false);
    const c = validSubmission();
    c.functions[0]!.functionKey = 'custom:pos-terminal';
    c.monitoring[0]!.functionKey = 'custom:pos-terminal';
    expect(fleetDesignSubmissionSchema.safeParse(c).success).toBe(false); // label missing
    (c.functions[0] as { label?: string }).label = 'POS terminal';
    expect(fleetDesignSubmissionSchema.safeParse(c).success).toBe(true);
  });
  it('rejects a device in two functions', () => {
    const s = validSubmission();
    s.functions.push({ functionKey: 'print_server', deviceIds: [D1], confidence: 0.8, evidence: ['spooler'] });
    expect(fleetDesignSubmissionSchema.safeParse(s).success).toBe(false);
  });
  it('legacy: requires coveredBy on a covered entry and classifies each script once (W04)', () => {
    const L = '33333333-3333-4333-8333-333333333333';
    const entry = { scriptId: L, scriptName: 'Old cleanup', intent: 'Free disk', bucket: 'covered' as const, notes: 'n' };
    const s = validSubmission();
    (s.legacy as unknown[]) = [entry];
    const r = fleetDesignSubmissionSchema.safeParse(s);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path.join('.'))).toContain('legacy.0.coveredBy');
    (s.legacy as unknown[]) = [{ ...entry, coveredBy: 'disk_cleanup module' }];
    expect(fleetDesignSubmissionSchema.safeParse(s).success).toBe(true);
    (s.legacy as unknown[]) = [{ ...entry, coveredBy: 'x' }, { ...entry, bucket: 'obsolete' }];
    const dup = fleetDesignSubmissionSchema.safeParse(s);
    expect(dup.success).toBe(false);
    expect(dup.error!.issues.map((i) => i.path.join('.'))).toContain('legacy.1.scriptId');
  });
});

describe('triggerFleetDesignRunSchema', () => {
  it('accepts orgId alone and orgId+siteId, rejects unknown keys and non-uuids', () => {
    expect(triggerFleetDesignRunSchema.safeParse({ orgId: D1 }).success).toBe(true);
    expect(triggerFleetDesignRunSchema.safeParse({ orgId: D1, siteId: D2 }).success).toBe(true);
    expect(triggerFleetDesignRunSchema.safeParse({ orgId: D1, deviceId: D2 }).success).toBe(false);
    expect(triggerFleetDesignRunSchema.safeParse({ orgId: 'not-a-uuid' }).success).toBe(false);
    expect(triggerFleetDesignRunSchema.safeParse({}).success).toBe(false);
  });
});

describe('fleetDesignOutcomeFromSubmission', () => {
  it('rejects a device id that is not in the evidence', () => {
    const s = validSubmission();
    s.functions[0]!.deviceIds = ['33333333-3333-4333-8333-333333333333'];
    expect(() => fleetDesignOutcomeFromSubmission(asSubmission(s), refs)).toThrow(/functions\[0\]\.deviceIds\[0\]/);
  });
  it('builds the outcome with every section exactly once, item refs, thresholds and baseline numbers', () => {
    const o = fleetDesignOutcomeFromSubmission(asSubmission(validSubmission()), refs);
    expect(o.schemaVersion).toBe(1);
    expect(Object.keys(o.sections)).toEqual([...FLEET_DESIGN_SECTION_KEYS]);
    expect(o.sections.functions[0]!.itemRef).toBe('functions:file_server');
    expect(o.sections.monitoring[0]!.watches[0]!.itemRef).toBe('monitoring:file_server:watch:0');
    expect(o.sections.monitoring[0]!.alertRules[0]!.itemRef).toBe('monitoring:file_server:rule:0');
    expect(o.sections.baseline.numbers.alertsPer100EndpointsPerMonth).toBe(42);
    expect(o.thresholds.confidence).toBe(FLEET_DESIGN_CONFIDENCE_THRESHOLD);
    expect(o.markdown).toContain('## What was found');
  });
});

describe('renderFleetDesignMarkdown', () => {
  it('renders eight headings in order and no raw markup from the model', () => {
    const s = validSubmission();
    s.found.summary = ['# not a heading'];
    const md = renderFleetDesignMarkdown(fleetDesignOutcomeFromSubmission(asSubmission(s), refs));
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toHaveLength(8);
    expect(md).not.toContain('\n# not');
  });
});

// W05c2 Task 15: Fleet Designer proposes monitor definitions, not legacy
// alert-rule condition arrays.
describe('fleetDesignRuleSchema (monitor-definition proposals)', () => {
  const monitorProposal = {
    name: 'Disk capacity', kind: 'disk',
    condition: { operator: 'gt', value: 85, durationMinutes: 15 }, severity: 'high',
    cooldownMinutes: 60, responses: [], deliveryMode: 'inherit', deliveryChannelIds: [],
    rationale: 'Data volume growth is the failure mode.', action: 'none', paging: 'business_hours',
  };
  it('accepts a validated monitor-definition proposal', () => {
    expect(fleetDesignRuleSchema.parse(monitorProposal)).toMatchObject(monitorProposal);
  });
  it('rejects legacy fields, invalid kind conditions and empty explicit delivery', () => {
    expect(fleetDesignRuleSchema.safeParse({ ...monitorProposal, conditions: [] }).success).toBe(false);
    expect(fleetDesignRuleSchema.safeParse({ ...monitorProposal, sourceTemplateId: D1 }).success).toBe(false);
    expect(fleetDesignRuleSchema.safeParse({ ...monitorProposal, kind: 'service' }).success).toBe(false);
    expect(fleetDesignRuleSchema.safeParse({ ...monitorProposal, deliveryMode: 'channels' }).success).toBe(false);
  });
  it('rejects ai_triage responses, which need an agent a proposal cannot name', () => {
    expect(fleetDesignRuleSchema.safeParse({
      ...monitorProposal, responses: [{ type: 'ai_triage' }],
    }).success).toBe(false);
  });
  it('the submission schema rejects a legacy rule-shaped proposal', () => {
    const sub = validSubmission() as any;
    sub.monitoring[0].alertRules[0] = {
      name: 'Old', severity: 'high', conditions: [{ type: 'metric', metric: 'disk', operator: 'gt', value: 85 }],
      cooldownMinutes: 60, rationale: 'r', action: 'none', paging: 'none',
    };
    expect(fleetDesignSubmissionSchema.safeParse(sub).success).toBe(false);
  });
});
