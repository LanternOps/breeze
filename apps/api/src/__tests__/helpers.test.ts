import { describe, it, expect } from 'vitest';
import { createTestToken } from './helpers';
import { verifyToken } from '../services/jwt';

describe('createTestToken', () => {
  it('mints aep/mep so authMiddleware epoch checks pass by default', async () => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
    const decoded = await verifyToken(await createTestToken());
    expect(decoded?.aep).toBe(1);
    expect(decoded?.mep).toBe(1);
    expect(decoded?.sid).toBeTruthy();
  });

  it('honors an explicit aep override', async () => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
    const decoded = await verifyToken(await createTestToken({ aep: 2 }));
    expect(decoded?.aep).toBe(2);
  });

  it("decodes sid: '' to undefined (missing-claim forge)", async () => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
    const decoded = await verifyToken(await createTestToken({ sid: '' }));
    expect(decoded?.sid).toBeUndefined();
  });

  it('decodes aep: null to undefined — a GENUINELY absent claim, not the default 1 (Task 7 gap #1)', async () => {
    process.env.JWT_SECRET = 'test-secret-at-least-32-chars-long-xxxxx';
    const decoded = await verifyToken(await createTestToken({ aep: null, mep: null }));
    expect(decoded?.aep).toBeUndefined();
    expect(decoded?.mep).toBeUndefined();
  });
});
