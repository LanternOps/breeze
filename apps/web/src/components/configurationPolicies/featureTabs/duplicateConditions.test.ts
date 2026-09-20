// duplicateConditions.test.ts
import { describe, expect, it } from 'vitest';
import type { FeatureLink } from './types';
import { effectiveAttachedMonitors, findDuplicateConditions } from './duplicateConditions';

const catalog = [
  { id: 'm-cpu', name: 'High CPU usage', kind: 'cpu', condition: { operator: 'gt', value: 90 } },
  { id: 'm-off', name: 'Device offline', kind: 'offline', condition: { durationMinutes: 15 } },
  { id: 'm-svc', name: 'Spooler stopped', kind: 'service', condition: { serviceName: 'Spooler' } },
  { id: 'm-dis', name: 'Disk almost full', kind: 'disk', condition: { operator: 'gt', value: 90 } },
];

describe('findDuplicateConditions', () => {
  it('flags an inline metric rule whose metric maps to an attached monitor kind', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-cpu', enabled: true }],
      catalog,
      inlineRules: [{ name: 'Alert Rule 1', conditions: [{ type: 'metric', metric: 'cpuPercent', operator: 'gt', value: 80 }] }],
      watches: [],
    });
    expect(hits).toEqual([{ monitorId: 'm-cpu', monitorName: 'High CPU usage', legacyLabel: 'Alert Rule 1', source: 'alert_rule' }]);
  });

  it('accepts the legacy threshold/status aliases', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-cpu', enabled: true }, { monitorId: 'm-off', enabled: true }],
      catalog,
      inlineRules: [
        { name: 'CPU', conditions: [{ type: 'threshold', metric: 'cpu', operator: 'gt', value: 80 }] },
        { name: 'Offline', conditions: [{ type: 'status', duration: 10 }] },
      ],
      watches: [],
    });
    expect(hits.map((h) => h.monitorId)).toEqual(['m-cpu', 'm-off']);
  });

  it('ignores disabled attachments and monitors not in the catalog', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-cpu', enabled: false }, { monitorId: 'ghost', enabled: true }],
      catalog,
      inlineRules: [{ name: 'CPU', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }] }],
      watches: [],
    });
    expect(hits).toEqual([]);
  });

  it('matches a service watch to a service monitor by name, case-insensitively', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-svc', enabled: true }],
      catalog,
      inlineRules: [],
      watches: [{ watchType: 'service', name: 'spooler', enabled: true }],
    });
    expect(hits).toEqual([{ monitorId: 'm-svc', monitorName: 'Spooler stopped', legacyLabel: 'spooler', source: 'monitoring' }]);
  });

  it('does not match a disabled watch or a different service', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-svc', enabled: true }],
      catalog,
      inlineRules: [],
      watches: [{ watchType: 'service', name: 'Spooler', enabled: false }, { watchType: 'service', name: 'W32Time', enabled: true }],
    });
    expect(hits).toEqual([]);
  });

  it('reports one hit per legacy row even when the rule has several conditions', () => {
    const hits = findDuplicateConditions({
      attached: [{ monitorId: 'm-cpu', enabled: true }, { monitorId: 'm-dis', enabled: true }],
      catalog,
      inlineRules: [{ name: 'Both', conditions: [
        { type: 'metric', metric: 'cpu', operator: 'gt', value: 80 },
        { type: 'metric', metric: 'disk', operator: 'gt', value: 80 },
      ] }],
      watches: [],
    });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.legacyLabel === 'Both')).toBe(true);
  });
});


describe('effectiveAttachedMonitors', () => {
  const link = (items: Array<{ monitorId: string; enabled?: boolean; overrides?: Record<string, unknown> }>): FeatureLink => ({
    id: 'link', featureType: 'monitors', featurePolicyId: null, inlineSettings: { items },
  });

  it('unions own and parent attachments without mutating either link', () => {
    const own = link([{ monitorId: 'm-off' }]);
    const parent = link([{ monitorId: 'm-cpu', enabled: true }]);
    const before = JSON.stringify([own, parent]);
    const attached = effectiveAttachedMonitors(own, parent);
    expect(attached).toHaveLength(2);
    expect(findDuplicateConditions({ attached, catalog, watches: [], inlineRules: [
      { name: 'CPU', conditions: [{ type: 'metric', metric: 'cpu' }] },
    ] })).toEqual([{ monitorId: 'm-cpu', monitorName: 'High CPU usage', legacyLabel: 'CPU', source: 'alert_rule' }]);
    expect(JSON.stringify([own, parent])).toBe(before);
  });

  it('keeps the entire own entry, including disabled state and overrides, for a shared monitor', () => {
    const own = { monitorId: 'm-cpu', enabled: false, overrides: { value: 95 } };
    const attached = effectiveAttachedMonitors(link([own]), link([{ monitorId: 'm-cpu', enabled: true, overrides: { value: 80 } }]));
    expect(attached).toEqual([own]);
    expect(findDuplicateConditions({ attached, catalog, watches: [], inlineRules: [
      { conditions: [{ type: 'metric', metric: 'cpu' }] },
    ] })).toEqual([]);
  });

  it('preserves attachments without a parent and handles missing links', () => {
    const items = [{ monitorId: 'm-cpu', enabled: true }];
    expect(effectiveAttachedMonitors(link(items), undefined)).toEqual(items);
    expect(effectiveAttachedMonitors(undefined, link(items))).toEqual(items);
    expect(effectiveAttachedMonitors(undefined, undefined)).toEqual([]);
  });
});
