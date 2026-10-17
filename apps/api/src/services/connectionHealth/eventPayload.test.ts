import { describe, expect, it } from 'vitest';
import {
  buildHealthEventPayload,
  dueHealthEvent,
  HEALTH_EVENT_TYPE,
  healthEventId,
  isSelfDeliveryOfHealthEvent,
  type HealthEventRow,
} from './eventPayload';

const OPENED = new Date('2026-10-15T10:00:00.000Z');
const RESOLVED = new Date('2026-10-16T10:00:00.000Z');

const row = (over: Partial<HealthEventRow> = {}): HealthEventRow => ({
  id: '0b6f7c2e-3a1d-4e5f-9a8b-7c6d5e4f3a2b',
  orgId: 'org-1',
  sourceKind: 'm365_connection',
  sourceId: 'conn-1',
  condition: 'grant_missing',
  severity: 'permanent',
  fixHref: '/integrations#m365',
  openedAt: OPENED,
  resolvedAt: null,
  resolution: null,
  flapCount: 0,
  eventState: null,
  ...over,
});

describe('dueHealthEvent', () => {
  it('an open org incident consumers were never told about is due opened', () => {
    expect(dueHealthEvent(row())).toBe('opened');
    expect(dueHealthEvent(row({ eventState: 'resolved' }))).toBe('opened'); // reopened after a published resolve
  });

  it('nothing is due once consumers are told the current state', () => {
    expect(dueHealthEvent(row({ eventState: 'opened' }))).toBeNull();
    expect(dueHealthEvent(row({ resolvedAt: RESOLVED, resolution: 'recovered', eventState: 'resolved' }))).toBeNull();
  });

  it('a resolve is due only when consumers were told opened', () => {
    expect(dueHealthEvent(row({ resolvedAt: RESOLVED, resolution: 'recovered', eventState: 'opened' }))).toBe('resolved');
    // Opened and resolved between two drains: consumers never heard of it, so nothing.
    expect(dueHealthEvent(row({ resolvedAt: RESOLVED, resolution: 'recovered', eventState: null }))).toBeNull();
  });

  it('pending rows and partner-wide incidents never emit', () => {
    expect(dueHealthEvent(row({ openedAt: null }))).toBeNull();
    expect(dueHealthEvent(row({ orgId: null }))).toBeNull();
    expect(dueHealthEvent(row({ orgId: null, resolvedAt: RESOLVED, eventState: 'opened' }))).toBeNull();
  });
});

describe('buildHealthEventPayload', () => {
  it('carries the documented fields only: no detail, display name, owner or recipients', () => {
    const p = buildHealthEventPayload(row({ resolvedAt: RESOLVED, resolution: 'retired' }));
    expect(p).toEqual({
      incidentId: row().id,
      orgId: 'org-1',
      sourceKind: 'm365_connection',
      sourceId: 'conn-1',
      condition: 'grant_missing',
      severity: 'permanent',
      fixHref: '/integrations#m365',
      openedAt: OPENED.toISOString(),
      resolvedAt: RESOLVED.toISOString(),
      resolution: 'retired',
    });
    // The builder takes a narrow row type, so these cannot leak even if a caller passes a full row.
    const full = { ...row(), detail: 'token=abc secret', displayName: 'user@example.com', ownerUserId: 'u-1', notifiedUserIds: ['u-2'] };
    const text = JSON.stringify(buildHealthEventPayload(full as HealthEventRow));
    for (const leak of ['token=abc', 'user@example.com', 'u-1', 'u-2', 'detail', 'displayName', 'owner']) {
      expect(text).not.toContain(leak);
    }
  });

  it('nulls the OAuth grant source id, which embeds the grant owner user id', () => {
    const p = buildHealthEventPayload(row({ sourceKind: 'oauth_grant', sourceId: 'user-uuid:client-1' }));
    expect(p.sourceId).toBeNull();
    expect(JSON.stringify(p)).not.toContain('user-uuid');
  });
});

describe('healthEventId', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('is a stable UUID the event bus accepts', () => {
    const a = healthEventId(row(), 'opened');
    expect(a).toMatch(uuid);
    expect(healthEventId(row(), 'opened')).toBe(a);
  });

  it('differs per transition, per reopen and per resolve', () => {
    const opened = healthEventId(row(), 'opened');
    const reopened = healthEventId(row({ flapCount: 1 }), 'opened');
    const resolved = healthEventId(row({ resolvedAt: RESOLVED }), 'resolved');
    const resolvedAgain = healthEventId(row({ resolvedAt: new Date(RESOLVED.getTime() + 60_000) }), 'resolved');
    expect(new Set([opened, reopened, resolved, resolvedAgain]).size).toBe(4);
  });
});

describe('isSelfDeliveryOfHealthEvent', () => {
  const event = (type: string, payload: unknown) => ({ type, payload });
  const WH = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

  it('matches a webhook incident event against the webhook it is about', () => {
    for (const type of Object.values(HEALTH_EVENT_TYPE)) {
      expect(isSelfDeliveryOfHealthEvent(event(type, { sourceKind: 'webhook', sourceId: WH }), WH)).toBe(true);
    }
  });

  it('never matches another webhook, another source kind, or another event type', () => {
    expect(isSelfDeliveryOfHealthEvent(event('integration.health_opened', { sourceKind: 'webhook', sourceId: WH }), 'other')).toBe(false);
    expect(isSelfDeliveryOfHealthEvent(event('integration.health_opened', { sourceKind: 'm365_sync', sourceId: WH }), WH)).toBe(false);
    expect(isSelfDeliveryOfHealthEvent(event('device.offline', { sourceKind: 'webhook', sourceId: WH }), WH)).toBe(false);
    expect(isSelfDeliveryOfHealthEvent(event('integration.health_opened', null), WH)).toBe(false);
    expect(isSelfDeliveryOfHealthEvent(event('integration.health_opened', 'x'), WH)).toBe(false);
  });
});
