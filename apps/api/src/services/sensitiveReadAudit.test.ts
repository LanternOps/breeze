import { describe, expect, expectTypeOf, it, vi } from 'vitest';

vi.mock('./auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

import { writeRouteAudit } from './auditEvents';
import { auditSensitiveRead } from './sensitiveReadAudit';

describe('auditSensitiveRead', () => {
  it('emits only the fixed sensitive-read identity and count schema', () => {
    const c = {
      req: { header: vi.fn(() => undefined) },
      get: vi.fn(() => ({
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'reader@example.com',
        },
      })),
    };

    auditSensitiveRead(c as never, {
      action: 'contract.document.download',
      orgId: '22222222-2222-4222-8222-222222222222',
      resourceType: 'contract_document',
      resourceId: '33333333-3333-4333-8333-333333333333',
      format: 'pdf',
      rowCount: 1,
      byteCount: 4096,
    });

    expect(writeRouteAudit).toHaveBeenCalledWith(c, {
      action: 'contract.document.download',
      orgId: '22222222-2222-4222-8222-222222222222',
      resourceType: 'contract_document',
      resourceId: '33333333-3333-4333-8333-333333333333',
      details: {
        format: 'pdf',
        rowCount: 1,
        byteCount: 4096,
      },
    });

    const serialized = JSON.stringify(vi.mocked(writeRouteAudit).mock.calls[0]?.[1]);
    for (const prohibited of [
      'content',
      'path',
      'url',
      'token',
      'headers',
      'credentials',
      'filename',
      'query',
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
  });

  it('does not expose arbitrary content or capability fields in its input type', () => {
    type Input = Parameters<typeof auditSensitiveRead>[1];
    expectTypeOf<Input>().not.toHaveProperty('content');
    expectTypeOf<Input>().not.toHaveProperty('path');
    expectTypeOf<Input>().not.toHaveProperty('token');
    expectTypeOf<Input>().not.toHaveProperty('metadata');
  });

  it('returns immediately after delegating to the non-blocking audit path', () => {
    vi.mocked(writeRouteAudit).mockImplementationOnce(() => {
      void Promise.reject(new Error('audit backend unavailable')).catch(() => undefined);
    });

    expect(() => auditSensitiveRead({
      req: { header: () => undefined },
      get: () => ({
        user: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'reader@example.com',
        },
      }),
    } as never, {
      action: 'file.download',
      orgId: '22222222-2222-4222-8222-222222222222',
      resourceType: 'device_file',
      resourceId: '33333333-3333-4333-8333-333333333333',
      format: 'binary',
      rowCount: 1,
      byteCount: 12,
    })).not.toThrow();
  });
});
