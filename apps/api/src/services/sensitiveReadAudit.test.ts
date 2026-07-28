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

  it('does not propagate a synchronous audit-delivery failure to the caller', () => {
    // `writeAuditEventAsync` is not an `async` function, so a throw raised
    // before it reaches the retry-backed `createAuditLogAsync` escapes
    // SYNCHRONOUSLY. The file-browser and contract-PDF handlers call
    // auditSensitiveRead from inside a try/catch that maps a throw to an error
    // response, so an escaping throw would downgrade a completed download.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(writeRouteAudit).mockImplementationOnce(() => {
      throw new Error('audit backend unavailable');
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

    expect(consoleError).toHaveBeenCalledWith(
      '[audit] sensitive-read audit failed:',
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});
