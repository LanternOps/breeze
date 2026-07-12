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
});
