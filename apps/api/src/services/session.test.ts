import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(),
    select: vi.fn(),
    delete: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  sessions: {
    id: 'id',
    userId: 'userId',
    tokenHash: 'tokenHash',
    expiresAt: 'expiresAt'
  }
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn()
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  gt: vi.fn()
}));

import { createSession, validateSession, invalidateSession } from './session';
import { db } from '../db';
import { nanoid } from 'nanoid';
import { eq, gt } from 'drizzle-orm';

const mockedDb = vi.mocked(db);
const mockedNanoid = vi.mocked(nanoid);
const mockedEq = vi.mocked(eq);
const mockedGt = vi.mocked(gt);

describe('session service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createSession', () => {
    it('should create a session and return the unhashed token', async () => {
      mockedNanoid.mockReturnValue('session-token');

      const returningMock = vi.fn().mockResolvedValue([
        {
          id: 'session-1',
          userId: 'user-1',
          expiresAt: new Date('2024-01-01T00:00:00.000Z')
        }
      ]);
      const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
      mockedDb.insert.mockReturnValue({ values: valuesMock } as any);

      const result = await createSession({
        userId: 'user-1',
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent'
      });

      const expectedHash = createHash('sha256').update('session-token').digest('hex');

      expect(valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          tokenHash: expectedHash,
          ipAddress: '127.0.0.1',
          userAgent: 'test-agent',
          expiresAt: expect.any(Date)
        })
      );
      expect(result).toEqual({
        id: 'session-1',
        userId: 'user-1',
        token: 'session-token',
        expiresAt: new Date('2024-01-01T00:00:00.000Z')
      });
    });
  });

  describe('validateSession', () => {
    it('should return user/session ids for a valid session', async () => {
      const limitMock = vi.fn().mockResolvedValue([
        { id: 'session-1', userId: 'user-1' }
      ]);
      const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      mockedDb.select.mockReturnValue({ from: fromMock } as any);

      const result = await validateSession('session-token');

      const expectedHash = createHash('sha256').update('session-token').digest('hex');
      expect(mockedEq).toHaveBeenCalledWith('tokenHash', expectedHash);
      expect(mockedGt).toHaveBeenCalledWith('expiresAt', expect.any(Date));
      expect(result).toEqual({ userId: 'user-1', sessionId: 'session-1' });
    });

    it('should return null when session is missing', async () => {
      const limitMock = vi.fn().mockResolvedValue([]);
      const whereMock = vi.fn().mockReturnValue({ limit: limitMock });
      const fromMock = vi.fn().mockReturnValue({ where: whereMock });
      mockedDb.select.mockReturnValue({ from: fromMock } as any);

      const result = await validateSession('missing-token');

      expect(result).toBeNull();
    });
  });

  describe('invalidateSession', () => {
    it('should delete the session by id', async () => {
      const whereMock = vi.fn().mockResolvedValue(undefined);
      mockedDb.delete.mockReturnValue({ where: whereMock } as any);

      await invalidateSession('session-1');

      expect(mockedDb.delete).toHaveBeenCalled();
      expect(mockedEq).toHaveBeenCalledWith('id', 'session-1');
    });
  });
});
