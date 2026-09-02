import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

import { writeAuditEvent, writeAuditEventAsync } from './auditEvents';
import { createAuditLogAsync } from './auditService';

function buildRequestLike(headers: Record<string, string> = {}) {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? undefined,
    },
  };
}

describe('writeAuditEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes audit logs with UUID actor/resource IDs unchanged', () => {
    const c = buildRequestLike({ 'user-agent': 'vitest' });

    writeAuditEvent(c, {
      orgId: '123e4567-e89b-42d3-a456-426614174000',
      actorType: 'user',
      actorId: '123e4567-e89b-42d3-a456-426614174001',
      action: 'device.update',
      resourceType: 'device',
      resourceId: '123e4567-e89b-42d3-a456-426614174002',
    });

    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: '123e4567-e89b-42d3-a456-426614174001',
        resourceId: '123e4567-e89b-42d3-a456-426614174002',
      })
    );
  });

  it('exposes the persistence promise for callers that require completion', async () => {
    let resolvePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });
    vi.mocked(createAuditLogAsync).mockReturnValueOnce(persistence);
    const c = buildRequestLike({ 'user-agent': 'vitest' });

    const result = writeAuditEventAsync(c, {
      orgId: null,
      actorType: 'api_key',
      actorId: '123e4567-e89b-42d3-a456-426614174001',
      action: 'partner_api.request',
      resourceType: 'partner_service_principal',
    });

    expect(result).toBe(persistence);
    resolvePersistence();
    await result;
  });

  it('normalizes non-UUID actor IDs and preserves raw actor ID in details', () => {
    const c = buildRequestLike({ 'user-agent': 'vitest' });

    writeAuditEvent(c, {
      orgId: '123e4567-e89b-42d3-a456-426614174000',
      actorType: 'agent',
      actorId: '3519d80280bb7a6164e898228c3431ccde61061b24ac42bd6134add9f91459f5',
      action: 'agent.eventlogs.submit',
      resourceType: 'device',
      resourceId: '123e4567-e89b-42d3-a456-426614174002',
      details: { submittedCount: 1 },
    });

    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: '00000000-0000-0000-0000-000000000000',
        details: expect.objectContaining({
          submittedCount: 1,
          rawActorId: '3519d80280bb7a6164e898228c3431ccde61061b24ac42bd6134add9f91459f5',
        }),
      })
    );
  });

  it('runs details through sanitizeAuditPayload — redacts secrets and caps depth', () => {
    const c = buildRequestLike({ 'user-agent': 'vitest' });

    writeAuditEvent(c, {
      orgId: '123e4567-e89b-42d3-a456-426614174000',
      actorType: 'user',
      actorId: '123e4567-e89b-42d3-a456-426614174001',
      action: 'oauth.grant.revoke',
      resourceType: 'oauth_grant',
      resourceId: '123e4567-e89b-42d3-a456-426614174002',
      details: {
        // These are the field names sanitizeAuditPayload's SECRET_FIELD_PATTERN
        // matches; the caller no longer has to remember to filter them.
        password: 'hunter2',
        token: 'brz_should_be_redacted',
        apiKey: 'brz_api_key_secret',
        clientSecret: 'oauth-client-secret',
        // Safe fields pass through.
        grantId: 'grant-123',
        revokedCount: 3,
      },
    });

    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          password: '[REDACTED]',
          token: '[REDACTED]',
          apiKey: '[REDACTED]',
          clientSecret: '[REDACTED]',
          grantId: 'grant-123',
          revokedCount: 3,
        }),
      })
    );
  });

  it('redacts Authorization-bearer patterns embedded inside arbitrary string fields', () => {
    const c = buildRequestLike({ 'user-agent': 'vitest' });

    // admin/abuse.ts persists raw err.message strings into details. If an
    // upstream error message ever echoes back an Authorization header, this
    // test documents that the sanitizer's per-string redaction strips it
    // before persistence.
    writeAuditEvent(c, {
      orgId: '123e4567-e89b-42d3-a456-426614174000',
      actorType: 'user',
      actorId: '123e4567-e89b-42d3-a456-426614174001',
      action: 'partner.suspended_for_abuse',
      resourceType: 'partner',
      resourceId: '123e4567-e89b-42d3-a456-426614174002',
      details: {
        upstreamError: 'fetch failed: Authorization: Bearer brz_leaked_token at /api',
      },
    });

    const call = vi.mocked(createAuditLogAsync).mock.calls.at(-1)?.[0];
    const persistedError = String(call?.details?.upstreamError ?? '');
    expect(persistedError).not.toContain('brz_leaked_token');
    expect(persistedError).toContain('[REDACTED]');
  });

  describe('actorType resolution (auditEvents.ts:68)', () => {
    // recordActionIntentEvent (services/actionIntents/metrics.ts) passes
    // actorType straight through without resolving it — this is the ONLY
    // place the actual fallback formula
    // (`event.actorType ?? (event.actorId ? 'user' : 'system')`) runs, so it
    // must be pinned here against the real, unmocked function.
    it('resolves to "user" when actorType is omitted but actorId is present', () => {
      const c = buildRequestLike({ 'user-agent': 'vitest' });

      writeAuditEvent(c, {
        orgId: '123e4567-e89b-42d3-a456-426614174000',
        actorId: '123e4567-e89b-42d3-a456-426614174001',
        action: 'action_intent.created',
        resourceType: 'action_intent',
        resourceId: '123e4567-e89b-42d3-a456-426614174002',
      });

      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'user' })
      );
    });

    it('resolves to "system" when both actorType and actorId are omitted', () => {
      const c = buildRequestLike({ 'user-agent': 'vitest' });

      writeAuditEvent(c, {
        orgId: '123e4567-e89b-42d3-a456-426614174000',
        action: 'action_intent.expired',
        resourceType: 'action_intent',
        resourceId: '123e4567-e89b-42d3-a456-426614174002',
      });

      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'system' })
      );
    });

    it('keeps an explicit actorType of "ai_agent" — the fallback never overrides a supplied value', () => {
      const c = buildRequestLike({ 'user-agent': 'vitest' });

      writeAuditEvent(c, {
        orgId: '123e4567-e89b-42d3-a456-426614174000',
        actorType: 'ai_agent',
        action: 'action_intent.created',
        resourceType: 'action_intent',
        resourceId: '123e4567-e89b-42d3-a456-426614174002',
        // No actorId — an ai_agent proposal has no human actor. If the
        // fallback ever ran (it must not, since actorType is supplied), the
        // absence of actorId would push this to 'system' instead.
      });

      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'ai_agent' })
      );
    });

    it('derives initiatedBy "ai" (not "manual") for actorType "ai_agent"', () => {
      const c = buildRequestLike({ 'user-agent': 'vitest' });

      // Bucketing ai_agent audit events under initiatedBy 'manual' (the
      // switch's default case) would undo the point of separating agent
      // actions from human ones — DeviceEventLogViewer.tsx renders and
      // filters on initiatedBy, so this is user-visible.
      writeAuditEvent(c, {
        orgId: '123e4567-e89b-42d3-a456-426614174000',
        actorType: 'ai_agent',
        action: 'action_intent.created',
        resourceType: 'action_intent',
        resourceId: '123e4567-e89b-42d3-a456-426614174002',
      });

      expect(createAuditLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({ initiatedBy: 'ai' })
      );
    });
  });

  it('normalizes non-UUID resource IDs and preserves raw resource ID in details', () => {
    const c = buildRequestLike({ 'user-agent': 'vitest' });

    writeAuditEvent(c, {
      orgId: '123e4567-e89b-42d3-a456-426614174000',
      actorType: 'agent',
      actorId: '123e4567-e89b-42d3-a456-426614174001',
      action: 'agent.command.result.submit',
      resourceType: 'device_command',
      resourceId: 'not-a-uuid-resource-id',
      details: { status: 'failed' },
    });

    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceId: undefined,
        details: expect.objectContaining({
          status: 'failed',
          rawResourceId: 'not-a-uuid-resource-id',
        }),
      })
    );
  });
});
