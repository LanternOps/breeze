import type { PresenceAssignedEntry, PresenceResponse, PresenceVisitor } from '@breeze/shared';

/** Presence fixtures (site location W2). Fictional names only. */
export const MAIN_OFFICE = { id: '44444444-4444-4444-8444-444444444444', name: 'Main Office' };
export const LAKESIDE = { id: '55555555-5555-4555-8555-555555555555', name: 'Lakeside' };
const hex40 = (n: number) => String(n).padStart(40, '0');
const deviceUuid = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`;
export const presenceDeviceId = deviceUuid;

export const presenceVisitor = (n: number, over: Partial<PresenceVisitor> = {}): PresenceVisitor => ({
  id: `presentation:overview:scope:visitor-${hex40(n)}`, deviceId: deviceUuid(n), label: 'LAPTOP-LOV-01', assignedSite: MAIN_OFFICE,
  network: { prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' }, macCorroborated: false,
  observedAt: '2026-10-12T09:12:00Z', freshUntil: '2026-10-12T10:12:00Z', suggestion: null, siteAssignmentConfirmedAt: null, ...over });

export const presenceAssigned = (n: number, over: Partial<PresenceAssignedEntry> = {}): PresenceAssignedEntry => ({
  deviceId: deviceUuid(n), label: 'DESKTOP-HD7K2QF', state: 'visiting', reason: null, matchedSite: LAKESIDE, declaringSites: null,
  network: { prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' }, macCorroborated: true,
  observedAt: '2026-10-12T09:12:00Z', freshUntil: '2026-10-12T10:12:00Z', suggestion: null, siteAssignmentConfirmedAt: null, ...over });

export const presenceFixture = (over: Partial<PresenceResponse> = {}): PresenceResponse => ({
  schemaVersion: 1, siteId: MAIN_OFFICE.id, asOf: '2026-10-12T09:30:00Z', authority: false, coverage: 'complete', ignoredDeclarations: 0,
  declaredNetworks: [], assigned: [], visitors: [], counts: { observedElsewhere: 0, unidentified: 0, unknown: 0, visiting: 0 },
  truncated: { assigned: false, visitors: false }, ...over });
