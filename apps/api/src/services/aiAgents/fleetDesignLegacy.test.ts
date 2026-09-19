/**
 * Fleet Designer W04 (#5654) — the legacy intent inventory contract (spec
 * §4.7, §4.14 "the intent-inventory classifier receives fixtures of obsolete,
 * covered, and needed scripts").
 *
 * The designer is a model, so "the classifier" is two deterministic halves we
 * can pin: what the model is SHOWN (every legacy-import script, the three
 * buckets, the rules) and what it may SUBMIT (the section-6 validator).
 */
import { describe, expect, it } from 'vitest';
import { fleetDesignSubmissionSchema } from '@breeze/shared';
import { buildFleetDesignTaskPrompt, type AgentRunPromptContext } from './runnerPrompt';
import type { DesignEvidence } from './designEvidence';

const DEVICE = '00000000-0000-4000-8000-0000000000e1';
const S1 = '00000000-0000-4000-8000-0000000000a1';
const S2 = '00000000-0000-4000-8000-0000000000a2';
const S3 = '00000000-0000-4000-8000-0000000000a3';
const S4 = '00000000-0000-4000-8000-0000000000a4';

type Script = DesignEvidence['automation']['scripts'][number];

function evidenceFixture(scripts: Script[]): DesignEvidence {
  return {
    org: { name: 'Acme Dental', partnerName: 'Northwind IT', timezone: 'UTC', siteName: null },
    window: { start: '2026-06-14T00:00:00.000Z', end: '2026-09-12T00:00:00.000Z' },
    devices: [{
      id: DEVICE, hostname: 'FS-01', osType: 'windows', osVersion: '2022', role: 'server',
      roleSource: 'agent', lastSeenAt: '2026-09-11T00:00:00.000Z', status: 'online', siteName: 'HQ',
      groupNames: [], tags: [], customFields: '', pendingReboot: false, reliabilityScore: 0.98,
    }],
    deviceIds: new Set([DEVICE]),
    devicesTotal: 1,
    devicesNotAssessed: 0,
    software: [],
    services: [],
    network: { assets: [], topology: [], baselines: 0, openChanges: [] },
    posture: [],
    health: { reliabilityWorst: [], fleetFindings: [], vulnerability: null, patching: null, backups: null, cis: null },
    configuration: { policies: [], assignments: [], alertTemplates: [] },
    automation: { playbooks: [], scripts },
    logs: [],
    counts: { alerts90d: 0, tickets90d: 0, endpoints: 1 },
    precursors: { diskOver: 0, rebootPending: 0, rebootPendingOver: 0, patchAgeOver: 0, certificateExpiring: null, backupMissed: 0, serviceRestartsOver: 0 },
    thresholds: { diskUsedPercent: 80, rebootPendingDays: 7, patchAgeDays: 30, certificateDays: 30, serviceRestartsPer30d: 2 },
    unavailable: [],
    truncated: false,
    approvedDesign: null,
    driftLive: null,
  };
}

function ctxWith(evidence: DesignEvidence): AgentRunPromptContext {
  return {
    agent: { name: 'Designer', kind: 'designer' },
    run: { id: 'run-1', mode: 'act', triggerKind: 'manual' },
    device: null, alert: null, ticket: null, anomaly: null, instructions: null,
    profile: 'design', correlationGroup: null, sweep: null, narrative: null,
    design: { trigger: 'manual', occurrenceKey: null, evidence },
  } as AgentRunPromptContext;
}

const legacyDiskCleanup: Script = {
  id: S1, name: 'Old disk cleanup', tags: ['legacy-import', 'maintenance'], legacyImport: true,
  description: 'Deletes temp files weekly', language: 'powershell', osTypes: ['windows'],
};
const currentScript: Script = {
  id: S4, name: 'Collect logs', tags: [], legacyImport: false,
  description: 'Zips the event logs', language: 'powershell', osTypes: ['windows'],
};

describe('buildFleetDesignTaskPrompt — legacy inventory', () => {
  it('lists every legacy-import script with id, name, tags and description head, and the three buckets', () => {
    const prompt = buildFleetDesignTaskPrompt(ctxWith(evidenceFixture([legacyDiskCleanup, currentScript])));
    expect(prompt).toContain(`legacy: ${S1} Old disk cleanup`);
    expect(prompt).toContain('[legacy-import, maintenance]');
    expect(prompt).toContain('Deletes temp files weekly');
    expect(prompt).toMatch(/obsolete \| covered \| needed/);
    expect(prompt).toContain('coveredBy names the module, template or playbook that replaces it');
    expect(prompt).toContain('Never modify or delete anything');
  });

  it('renders a non-legacy script as a script line, never as a legacy one', () => {
    const prompt = buildFleetDesignTaskPrompt(ctxWith(evidenceFixture([legacyDiskCleanup, currentScript])));
    expect(prompt).toContain(`script: ${S4} Collect logs`);
    expect(prompt).not.toContain(`legacy: ${S4}`);
  });

  it('tells the model to leave the legacy section empty when there are no legacy scripts', () => {
    const prompt = buildFleetDesignTaskPrompt(ctxWith(evidenceFixture([currentScript])));
    expect(prompt).not.toMatch(/^legacy: [0-9a-f-]{36}/m);
    expect(prompt).toContain('legacy: one entry per script listed above as legacy');
  });
});

function validSubmission() {
  return {
    found: { summary: ['1 device.'], findings: [] },
    functions: [{ functionKey: 'file_server', deviceIds: [DEVICE], confidence: 0.9, evidence: ['SMB listener'] }],
    monitoring: [],
    retired: [],
    automation: [] as Array<Record<string, unknown>>,
    legacy: [] as Array<Record<string, unknown>>,
    baseline: { notes: [] },
    unsure: { lowConfidenceFunctions: [], unreachableDevices: [], needsHuman: [], roleCorrections: [] },
  };
}

describe('fleetDesignSubmissionSchema — legacy section (obsolete / covered / needed fixtures)', () => {
  it('accepts obsolete, covered (with coveredBy) and needed (with a replacement script) entries', () => {
    const s = validSubmission();
    s.legacy = [
      { scriptId: S1, scriptName: 'Old disk cleanup', intent: 'Free disk space weekly', bucket: 'covered', coveredBy: 'disk_cleanup module', notes: 'Built-in disk cleanup replaces it.' },
      { scriptId: S2, scriptName: 'Map drive H', intent: 'Map a departmental share', bucket: 'obsolete', notes: 'Share decommissioned.' },
      { scriptId: S3, scriptName: 'Reset print spooler', intent: 'Restart spooler when stuck', bucket: 'needed', notes: 'No module covers it; replacement proposed under automation.' },
    ];
    s.automation.push({
      functionKey: 'file_server', playbooks: [],
      scripts: [{ name: 'Restart print spooler', purpose: 'Restart spooler when stuck', osTypes: ['windows'], language: 'powershell', content: 'Restart-Service Spooler' }],
    });
    const parsed = fleetDesignSubmissionSchema.safeParse(s);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('rejects covered without coveredBy', () => {
    const s = validSubmission();
    s.legacy = [{ scriptId: S1, scriptName: 'Old disk cleanup', intent: 'Free disk space weekly', bucket: 'covered', notes: 'Covered.' }];
    const parsed = fleetDesignSubmissionSchema.safeParse(s);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.some((i) => i.path.join('.') === 'legacy.0.coveredBy')).toBe(true);
  });

  it('rejects the same legacy script classified twice (its item ref would collide)', () => {
    const s = validSubmission();
    const entry = { scriptId: S2, scriptName: 'Map drive H', intent: 'Map a share', bucket: 'obsolete', notes: 'Gone.' };
    s.legacy = [entry, { ...entry, bucket: 'needed' }];
    const parsed = fleetDesignSubmissionSchema.safeParse(s);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.some((i) => i.path.join('.') === 'legacy.1.scriptId')).toBe(true);
  });

  it('rejects an unknown bucket', () => {
    const s = validSubmission();
    s.legacy = [{ scriptId: S2, scriptName: 'Map drive H', intent: 'Map a share', bucket: 'delete', notes: 'x' }];
    expect(fleetDesignSubmissionSchema.safeParse(s).success).toBe(false);
  });
});
