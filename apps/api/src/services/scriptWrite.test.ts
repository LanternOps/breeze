import { describe, it, expect, vi, beforeEach } from 'vitest';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const PARTNER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const h = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>
}));

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        h.inserts.push(values);
        return { returning: vi.fn(() => Promise.resolve([{ id: 'new-script', ...values }])) };
      })
    }))
  }
}));

import {
  resolveScriptCreateScope,
  insertScriptRow,
  isScriptScopeError,
  type ScriptWriteAuth
} from './scriptWrite';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';

function makeAuth(overrides: Partial<ScriptWriteAuth> = {}): ScriptWriteAuth {
  return {
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    partnerOrgAccess: 'selected',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    ...overrides
  } as ScriptWriteAuth;
}

const input = {
  name: 'Test',
  osTypes: ['windows'],
  language: 'powershell' as const,
  content: 'Write-Host hi',
  timeoutSeconds: 300,
  runAs: 'system' as const
};

beforeEach(() => {
  vi.clearAllMocks();
  h.inserts = [];
});

describe('resolveScriptCreateScope', () => {
  it('org scope always lands in the caller org, ignoring a requested orgId', () => {
    const scope = resolveScriptCreateScope(
      makeAuth({ scope: 'organization', orgId: ORG_ID }),
      undefined,
      OTHER_ORG_ID
    );
    expect(scope).toEqual({ orgId: ORG_ID, partnerId: PARTNER_ID });
  });

  it("denies partner-wide creation to a partner user without the capability (#3262)", () => {
    const scope = resolveScriptCreateScope(makeAuth({ partnerOrgAccess: 'selected' }), 'partner', undefined);
    expect(scope).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, status: 403 });
  });

  it("grants partner-wide creation to a full-partner admin", () => {
    const scope = resolveScriptCreateScope(makeAuth({ partnerOrgAccess: 'all' }), 'partner', undefined);
    expect(scope).toEqual({ orgId: null, partnerId: PARTNER_ID });
  });

  it('denies an inaccessible org for partner scope', () => {
    const scope = resolveScriptCreateScope(makeAuth(), 'org', OTHER_ORG_ID);
    expect(scope).toEqual({ error: 'Access to this organization denied', status: 403 });
  });

  it('requires orgId when the partner has multiple organizations', () => {
    const scope = resolveScriptCreateScope(
      makeAuth({ accessibleOrgIds: [ORG_ID, OTHER_ORG_ID] }),
      undefined,
      undefined
    );
    expect(isScriptScopeError(scope) && scope.status === 400).toBe(true);
  });

  it('falls back to the single accessible org for partner scope', () => {
    const scope = resolveScriptCreateScope(makeAuth(), undefined, undefined);
    expect(scope).toEqual({ orgId: ORG_ID, partnerId: PARTNER_ID });
  });

  it("system scope ignores availability and takes the requested org (never partner-wide)", () => {
    const scope = resolveScriptCreateScope(
      makeAuth({ scope: 'system', partnerId: null, partnerOrgAccess: undefined }),
      'partner',
      ORG_ID
    );
    expect(scope).toEqual({ orgId: ORG_ID, partnerId: null });
  });
});

describe('insertScriptRow', () => {
  it('clamps isSystem to false for non-system scopes even when requested', async () => {
    await insertScriptRow(
      { scope: 'partner', user: { id: 'u1' } } as Parameters<typeof insertScriptRow>[0],
      { orgId: ORG_ID, partnerId: PARTNER_ID },
      input,
      { requestedIsSystem: true }
    );
    expect(h.inserts[0]!.isSystem).toBe(false);
  });

  it('honours requestedIsSystem only for system scope', async () => {
    await insertScriptRow(
      { scope: 'system', user: { id: 'u1' } } as Parameters<typeof insertScriptRow>[0],
      { orgId: null, partnerId: null },
      input,
      { requestedIsSystem: true }
    );
    expect(h.inserts[0]!.isSystem).toBe(true);
  });

  it('defaults isSystem to false when the option is omitted — the bundle-import path', async () => {
    await insertScriptRow(
      { scope: 'system', user: { id: 'u1' } } as Parameters<typeof insertScriptRow>[0],
      { orgId: ORG_ID, partnerId: null },
      input
    );
    expect(h.inserts[0]!.isSystem).toBe(false);
    expect(h.inserts[0]!.orgId).toBe(ORG_ID);
  });
});
