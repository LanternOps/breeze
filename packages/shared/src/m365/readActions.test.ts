import { describe, expect, it } from 'vitest';
import {
  M365_READ_ACTION_IDS,
  M365_READ_ACTION_FIELDS,
  m365ReadActionSchema,
  readActionRequestSchema,
  readActionResultSchema,
  readActionFailureCodeSchema,
} from './readActions';

const GUID = '11111111-2222-3333-4444-555555555555';

describe('m365 read action contracts', () => {
  it('defines exactly the 12 catalog actions with non-empty field allowlists', () => {
    expect(M365_READ_ACTION_IDS).toEqual([
      'm365.user.list', 'm365.user.get', 'm365.signins.list',
      'm365.intune.device.list', 'm365.intune.device.get',
      'm365.group.list', 'm365.group.get', 'm365.group.members.list',
      'm365.org.get', 'm365.org.skus.list',
      'm365.sites.list', 'm365.site.get',
    ]);
    for (const id of M365_READ_ACTION_IDS) {
      expect(M365_READ_ACTION_FIELDS[id].length).toBeGreaterThan(0);
      expect(new Set(M365_READ_ACTION_FIELDS[id]).size).toBe(M365_READ_ACTION_FIELDS[id].length);
    }
  });

  it('accepts every action variant at its bounds', () => {
    const variants = [
      { type: 'm365.user.list', search: 'ada', accountEnabled: true, pageSize: 50 },
      { type: 'm365.user.get', userIdOrUpn: 'ada@contoso.com' },
      { type: 'm365.signins.list', userPrincipalName: 'ada@contoso.com', sinceHours: 168, pageSize: 50 },
      { type: 'm365.intune.device.list', complianceState: 'noncompliant', pageSize: 50 },
      { type: 'm365.intune.device.get', deviceId: GUID },
      { type: 'm365.group.list', search: 'staff', pageSize: 50 },
      { type: 'm365.group.get', groupId: GUID },
      { type: 'm365.group.members.list', groupId: GUID, pageSize: 100 },
      { type: 'm365.org.get' },
      { type: 'm365.org.skus.list' },
      { type: 'm365.sites.list', search: 'intranet' },
      { type: 'm365.site.get', siteId: 'contoso.sharepoint.com,111,222' },
    ];
    for (const action of variants) {
      expect(m365ReadActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true);
      expect(readActionRequestSchema.safeParse({
        correlationId: GUID, tenantId: GUID, action,
      }).success).toBe(true);
    }
  });

  it('rejects out-of-bound and unknown inputs', () => {
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.list', pageSize: 51 }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.signins.list', sinceHours: 169 }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.sites.list' }).success).toBe(false); // search required
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.get', userIdOrUpn: "a'; drop--@x.com" }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.mail.send' }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.list', extra: 1 }).success).toBe(false);
  });

  it('round-trips collection, resource, and failure results', () => {
    expect(readActionResultSchema.safeParse({
      success: true, kind: 'collection', items: [{ id: GUID }], truncated: false,
    }).success).toBe(true);
    expect(readActionResultSchema.safeParse({
      success: true, kind: 'resource', resource: { id: GUID },
    }).success).toBe(true);
    expect(readActionResultSchema.safeParse({
      success: false, errorCode: 'graph_throttled', retryAfterSeconds: 30,
    }).success).toBe(true);
    expect(readActionFailureCodeSchema.safeParse('grant_missing').success).toBe(false);
  });
});
