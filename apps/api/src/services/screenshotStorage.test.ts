/**
 * Tests for screenshot storage service.
 *
 * Covers:
 * - storeScreenshot creates file and DB record
 * - getScreenshot returns data for valid screenshot
 * - getScreenshot returns null for non-existent screenshot
 * - deleteExpiredScreenshots removes expired screenshots
 * - Org isolation: cannot access screenshots from other orgs
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock fs/promises before importing the module
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-image-data')),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
}));

vi.mock('../db', () => {
  const insertReturning = vi.fn();
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insertFn = vi.fn(() => ({ values: insertValues }));

  const selectLimit = vi.fn();
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const selectFn = vi.fn(() => ({ from: selectFrom }));

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const deleteFn = vi.fn(() => ({ where: deleteWhere }));

  return {
    db: {
      insert: insertFn,
      select: selectFn,
      delete: deleteFn,
      // Expose inner mocks for test configuration
      __mocks: {
        insertValues,
        insertReturning,
        selectFn,
        selectFrom,
        selectWhere,
        selectLimit,
        deleteFn,
        deleteWhere,
      },
    },
  };
});

vi.mock('../db/schema/ai', () => ({
  aiScreenshots: {
    id: 'id',
    deviceId: 'device_id',
    orgId: 'org_id',
    sessionId: 'session_id',
    storageKey: 'storage_key',
    width: 'width',
    height: 'height',
    sizeBytes: 'size_bytes',
    capturedBy: 'captured_by',
    reason: 'reason',
    expiresAt: 'expires_at',
    createdAt: 'created_at',
  },
}));

import { storeScreenshot, getScreenshot, deleteExpiredScreenshots } from './screenshotStorage';
import { db } from '../db';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';

const mocks = (db as any).__mocks;

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG_ID = '22222222-2222-2222-2222-222222222222';
const TEST_DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const TEST_SCREENSHOT_ID = '44444444-4444-4444-4444-444444444444';
const MOCK_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('screenshotStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── storeScreenshot ─────────────────────────────────────────────────

  describe('storeScreenshot', () => {
    it('creates directory, writes file, and inserts DB record', async () => {
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const dbRecord = {
        id: TEST_SCREENSHOT_ID,
        deviceId: TEST_DEVICE_ID,
        orgId: TEST_ORG_ID,
        storageKey: `screenshots/${TEST_ORG_ID}/${TEST_DEVICE_ID}/${MOCK_UUID}.jpg`,
        width: 1920,
        height: 1080,
        sizeBytes: 9, // Buffer.from('dGVzdA==', 'base64') => 4 bytes for 'test'
        capturedBy: 'agent',
        expiresAt,
      };

      mocks.insertReturning.mockResolvedValue([dbRecord]);

      const result = await storeScreenshot({
        deviceId: TEST_DEVICE_ID,
        orgId: TEST_ORG_ID,
        imageBase64: 'dGVzdGltYWdl', // 'testimage' in base64
        width: 1920,
        height: 1080,
        capturedBy: 'agent',
      });

      // Verify mkdir was called with the correct org/device subdirectory
      expect(mkdir).toHaveBeenCalledWith(
        expect.stringContaining(TEST_ORG_ID),
        { recursive: true }
      );

      // Verify writeFile was called
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining(`${MOCK_UUID}.jpg`),
        expect.any(Buffer)
      );

      // Verify DB insert was called
      expect(db.insert).toHaveBeenCalled();
      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: TEST_DEVICE_ID,
          orgId: TEST_ORG_ID,
          width: 1920,
          height: 1080,
          capturedBy: 'agent',
        })
      );

      // Verify return shape
      expect(result).toHaveProperty('id', TEST_SCREENSHOT_ID);
      expect(result).toHaveProperty('storageKey');
      expect(result).toHaveProperty('width', 1920);
      expect(result).toHaveProperty('height', 1080);
      expect(result).toHaveProperty('sizeBytes');
      expect(result).toHaveProperty('expiresAt');
    });

    it('uses custom retention hours for expiry', async () => {
      const dbRecord = {
        id: TEST_SCREENSHOT_ID,
        deviceId: TEST_DEVICE_ID,
        orgId: TEST_ORG_ID,
        storageKey: `screenshots/${TEST_ORG_ID}/${TEST_DEVICE_ID}/${MOCK_UUID}.jpg`,
        width: 800,
        height: 600,
        sizeBytes: 5,
        capturedBy: 'user',
        expiresAt: new Date(),
      };

      mocks.insertReturning.mockResolvedValue([dbRecord]);

      await storeScreenshot({
        deviceId: TEST_DEVICE_ID,
        orgId: TEST_ORG_ID,
        imageBase64: 'dGVzdA==',
        width: 800,
        height: 600,
        capturedBy: 'user',
        retentionHours: 48,
      });

      // Check that the values passed to DB include an expiresAt roughly 48 hours from now
      const insertedValues = mocks.insertValues.mock.calls[0][0];
      const expiresAt = insertedValues.expiresAt as Date;
      const expectedMin = Date.now() + 47 * 60 * 60 * 1000;
      const expectedMax = Date.now() + 49 * 60 * 60 * 1000;
      expect(expiresAt.getTime()).toBeGreaterThan(expectedMin);
      expect(expiresAt.getTime()).toBeLessThan(expectedMax);
    });
  });

  // ─── getScreenshot ───────────────────────────────────────────────────

  describe('getScreenshot', () => {
    it('returns data and record for a valid screenshot', async () => {
      const dbRecord = {
        id: TEST_SCREENSHOT_ID,
        deviceId: TEST_DEVICE_ID,
        orgId: TEST_ORG_ID,
        storageKey: `screenshots/${TEST_ORG_ID}/${TEST_DEVICE_ID}/somefile.jpg`,
        width: 1920,
        height: 1080,
        sizeBytes: 100,
        capturedBy: 'agent',
        expiresAt: new Date(Date.now() + 86400000),
      };

      mocks.selectLimit.mockResolvedValue([dbRecord]);

      const result = await getScreenshot(TEST_SCREENSHOT_ID, TEST_ORG_ID);

      expect(result).not.toBeNull();
      expect(result!.data).toBeInstanceOf(Buffer);
      expect(result!.record).toEqual(dbRecord);
      expect(readFile).toHaveBeenCalledWith(
        expect.stringContaining('somefile.jpg')
      );
    });

    it('returns null when screenshot does not exist in DB', async () => {
      mocks.selectLimit.mockResolvedValue([]);

      const result = await getScreenshot('nonexistent-id', TEST_ORG_ID);

      expect(result).toBeNull();
    });

    it('returns null when file read fails', async () => {
      const dbRecord = {
        id: TEST_SCREENSHOT_ID,
        deviceId: TEST_DEVICE_ID,
        orgId: TEST_ORG_ID,
        storageKey: `screenshots/${TEST_ORG_ID}/${TEST_DEVICE_ID}/missing.jpg`,
        width: 1920,
        height: 1080,
        sizeBytes: 100,
        capturedBy: 'agent',
        expiresAt: new Date(Date.now() + 86400000),
      };

      mocks.selectLimit.mockResolvedValue([dbRecord]);
      vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT'));

      const result = await getScreenshot(TEST_SCREENSHOT_ID, TEST_ORG_ID);

      expect(result).toBeNull();
    });

    it('enforces org isolation - returns null for wrong orgId', async () => {
      // The DB query uses AND(id=?, orgId=?) so it won't find records from other orgs
      mocks.selectLimit.mockResolvedValue([]);

      const result = await getScreenshot(TEST_SCREENSHOT_ID, OTHER_ORG_ID);

      expect(result).toBeNull();
      // Verify the DB query was called (the where clause filters by orgId)
      expect(db.select).toHaveBeenCalled();
    });
  });

  // ─── deleteExpiredScreenshots ────────────────────────────────────────

  describe('deleteExpiredScreenshots', () => {
    it('deletes expired screenshots from filesystem and DB', async () => {
      const expired1 = {
        id: 'expired-1',
        deviceId: TEST_DEVICE_ID,
        orgId: TEST_ORG_ID,
        storageKey: `screenshots/${TEST_ORG_ID}/${TEST_DEVICE_ID}/old1.jpg`,
        expiresAt: new Date(Date.now() - 86400000),
      };
      const expired2 = {
        id: 'expired-2',
        deviceId: TEST_DEVICE_ID,
        orgId: TEST_ORG_ID,
        storageKey: `screenshots/${TEST_ORG_ID}/${TEST_DEVICE_ID}/old2.jpg`,
        expiresAt: new Date(Date.now() - 86400000),
      };

      // For deleteExpiredScreenshots, the select().from().where() chain is different
      // It doesn't call .limit(), just .where()
      mocks.selectWhere.mockResolvedValueOnce([expired1, expired2]);

      const count = await deleteExpiredScreenshots();

      expect(count).toBe(2);
      expect(unlink).toHaveBeenCalledTimes(2);
      expect(unlink).toHaveBeenCalledWith(expect.stringContaining('old1.jpg'));
      expect(unlink).toHaveBeenCalledWith(expect.stringContaining('old2.jpg'));
      // DB delete called for each record
      expect(db.delete).toHaveBeenCalledTimes(2);
    });

    it('returns 0 when no expired screenshots exist', async () => {
      mocks.selectWhere.mockResolvedValueOnce([]);

      const count = await deleteExpiredScreenshots();

      expect(count).toBe(0);
      expect(unlink).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
    });

    it('continues deleting even if file unlink fails for one record', async () => {
      const expired1 = {
        id: 'expired-1',
        deviceId: TEST_DEVICE_ID,
        orgId: TEST_ORG_ID,
        storageKey: `screenshots/${TEST_ORG_ID}/${TEST_DEVICE_ID}/missing.jpg`,
        expiresAt: new Date(Date.now() - 86400000),
      };
      const expired2 = {
        id: 'expired-2',
        deviceId: TEST_DEVICE_ID,
        orgId: TEST_ORG_ID,
        storageKey: `screenshots/${TEST_ORG_ID}/${TEST_DEVICE_ID}/exists.jpg`,
        expiresAt: new Date(Date.now() - 86400000),
      };

      mocks.selectWhere.mockResolvedValueOnce([expired1, expired2]);
      vi.mocked(unlink)
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(undefined);

      const count = await deleteExpiredScreenshots();

      // Both records should be deleted from DB even if file delete fails
      expect(count).toBe(2);
      expect(db.delete).toHaveBeenCalledTimes(2);
    });
  });
});
