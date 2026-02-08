import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./auditService', () => ({
  createAuditLogAsync: vi.fn(),
}));

import { writeAuditEvent } from './auditEvents';
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
