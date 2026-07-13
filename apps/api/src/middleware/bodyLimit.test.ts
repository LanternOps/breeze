import { describe, it, expect } from 'vitest';
import { bodyLimitForPath } from './bodyLimit';

const MB = 1024 * 1024;

describe('bodyLimitForPath', () => {
  it('applies the tight 1MB default to ordinary routes', () => {
    expect(bodyLimitForPath('/api/v1/devices')).toEqual({
      maxSize: 1 * MB,
      error: 'Request body too large',
    });
    expect(bodyLimitForPath('/api/v1/software/catalog')).toEqual({
      maxSize: 1 * MB,
      error: 'Request body too large',
    });
  });

  it('carves out dev-push binary uploads at 150MB', () => {
    expect(bodyLimitForPath('/api/v1/dev/push')).toEqual({
      maxSize: 150 * MB,
      error: 'Binary too large (max 150MB)',
    });
    expect(bodyLimitForPath('/api/v1/dev/push/anything')).toEqual({
      maxSize: 150 * MB,
      error: 'Binary too large (max 150MB)',
    });
  });

  it('carves out remote file-transfer chunk uploads at 50MB', () => {
    expect(bodyLimitForPath('/api/v1/remote/transfers/abc-123/chunks')).toEqual({
      maxSize: 50 * MB,
      error: 'Chunk too large (max 50MB)',
    });
  });

  // Regression for #2401: agent command results on the heartbeat/REST
  // fallback leg can legitimately carry multi-MB stdout (capture_pprof
  // profiles, big script output). commandResultSchema caps stdout/stderr at
  // 5MB each; the body limit must not 413 a schema-valid result.
  it('carves out agent command-result submissions at 12MB', () => {
    expect(
      bodyLimitForPath('/api/v1/agents/agent-1/commands/11111111-1111-4111-8111-111111111111/result'),
    ).toEqual({
      maxSize: 12 * MB,
      error: 'Command result too large (max 12MB)',
    });
    // Sibling agent routes keep the default.
    expect(bodyLimitForPath('/api/v1/agents/agent-1/commands').maxSize).toBe(1 * MB);
    expect(bodyLimitForPath('/api/v1/agents/agent-1/heartbeat').maxSize).toBe(1 * MB);
  });

  // Sized from the agent's 4MB file_write cap (~5.6MB base64 + JSON envelope);
  // the agent's WS read limit is derived from the same cap (issue #2399).
  it('carves out file-browser uploads at 8MB', () => {
    expect(bodyLimitForPath('/api/v1/system-tools/devices/dev-1/files/upload')).toEqual({
      maxSize: 8 * MB,
      error: 'File too large (max 4MB); use file transfer for larger files',
    });
  });

  // Regression for #1377: the software package (installer) upload route must get a
  // 500MB+ carve-out, not the 1MB default. Before the fix, any installer over 1MB
  // was rejected by the global gate with "Request body too large" before the route's
  // own 500MB MAX_UPLOAD_SIZE check could run.
  it('carves out software package installer uploads above the route 500MB cap (#1377)', () => {
    const result = bodyLimitForPath('/api/v1/software/catalog/cat-123/versions/upload');
    expect(result.error).toBe('Package too large (max 500MB)');
    expect(result.maxSize).toBeGreaterThan(500 * MB);
    expect(result.maxSize).toBe(512 * MB);
  });

  it('does not over-match the software carve-out to sibling software routes', () => {
    // The version metadata route (no file body) and the catalog list must stay at the default.
    expect(bodyLimitForPath('/api/v1/software/catalog/cat-123/versions').maxSize).toBe(1 * MB);
    expect(bodyLimitForPath('/api/v1/software/catalog/cat-123/versions/upload/extra').maxSize).toBe(1 * MB);
  });
});
