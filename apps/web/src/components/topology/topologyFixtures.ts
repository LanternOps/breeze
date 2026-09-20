import type { GraphResponse, TopologySiteSettings } from '@breeze/shared';
export const SITE = '11111111-1111-4111-8111-111111111111', NODE = '22222222-2222-4222-8222-222222222222', ASSET = '33333333-3333-4333-8333-333333333333';
export const topologyGraphFixture = (): GraphResponse => ({
  schemaVersion: 1, siteId: SITE, view: 'overview', asOf: '2026-09-16T12:00:00Z', revisions: { graph: '1', health: '1', layout: '0' },
  nodes: [{ id: NODE, kind: 'gateway', role: 'gateway', label: 'Reported gateway', bindings: [{ id: ASSET, type: 'discovered_asset', referenceId: ASSET }], lifecycle: 'active', freshness: 'fresh', evidence: { classes: ['observed'], methods: ['os_route'], count: '1', lastObservedAt: '2026-09-16T12:00:00Z' }, health: { status: 'unknown', coverage: 'unmonitored', scope: 'node', originNodeId: null, resultId: null, reasons: [{ code: 'not_measured', message: 'Not measured' }], freshness: 'unknown' }, availableActions: ['diagnose'] }],
  relationships: [], presentation: { nodes: [], edges: [] }, layout: { algorithm: 'none', version: 0, positions: [] },
  counts: { totalNodes: 1, totalRelationships: 0, visibleNodes: 1, visibleRelationships: 0, omittedNodes: 0, omittedRelationships: 0 }, coverage: { state: 'limited', reasons: [{ code: 'limited', message: 'Logical evidence only' }] }, frontier: [], permissions: { canEdit: true, canDiagnose: true, canConfigureMonitoring: true },
});
export const topologySettingsFixture = (): TopologySiteSettings => {
  const yes = { available: true, reason: null }, no = { available: false, reason: 'capability_unavailable' };
  return { siteId: SITE, settingsRevision: '1', flags: { materialization: true, ui: true, physical: false, interfaceHealth: false, diagnostics: true, ai: false },
    capabilities: { materialization: yes, ui: yes, collection: yes, physical: no, interfaceHealth: no, diagnostics: yes, ai: no, recurringMonitoring: no },
    permissions: { canEdit: true, canDiagnose: true, canConfigureMonitoring: true },
    resolved: { settings: { targets: {}, policies: {} }, digest: 'a'.repeat(64), provenance: {}, validationEffects: [] },
    binding: { partnerVersionId: null, orgVersionId: null, bindingRevision: '1', defaultsVersion: 1, schemaVersion: 1, resolverVersion: 1, overrides: { targets: {}, policies: {} } },
  };
};
