import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray, like, sql } from 'drizzle-orm';

const { sendOpsAlertMock } = vi.hoisted(() => ({ sendOpsAlertMock: vi.fn() }));
vi.mock('../../services/opsAlerts', () => ({ sendOpsAlert: sendOpsAlertMock }));

import { db, withSystemDbAccessContext } from '../../db';
import { aiPlatformModels } from '../../db/schema';
import { syncPlatformModels, type AnthropicModelInfo } from '../../services/aiModels/discovery';
import { getPlatformModelByModelId } from '../../services/aiModels/platformModels';
import { SEEDED_PLATFORM_MODELS } from '../../services/aiModels/__fixtures__/seededPlatformModels';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const ENV = { ANTHROPIC_API_KEY: 'test-key' };
const HOURS = 3_600_000;
const CAPS = {
  thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
};
const PREFIX = `w01-disc-${randomUUID().slice(0, 8)}`;

function listed(...ids: string[]): AnthropicModelInfo[] {
  return ids.map((id) => ({ id, displayName: id, maxInputTokens: 1000, maxOutputTokens: 100, capabilities: CAPS }));
}

async function sync(ids: string[], at: Date) {
  return syncPlatformModels({ env: ENV, discover: async () => listed(...ids), now: () => at });
}

beforeEach(() => {
  sendOpsAlertMock.mockReset();
  sendOpsAlertMock.mockResolvedValue(true);
});

afterEach(async () => {
  await withSystemDbAccessContext(() => db.delete(aiPlatformModels).where(like(aiPlatformModels.modelId, `${PREFIX}%`)));
});

describe('syncPlatformModels against real Postgres (W01 #7599)', () => {
  runDb('a new id lands unpriced and unoffered, alerts the operator once, and is marked notified', async () => {
    const id = `${PREFIX}-new`;
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    const first = await sync([id], t0);
    expect(first).toMatchObject({ status: 'ok', inserted: [id], operatorNotified: true });
    expect(sendOpsAlertMock).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(id) }));
    const row = (await getPlatformModelByModelId(id))!;
    expect(row).toMatchObject({ rates: null, platformOffered: false, isPlatformDefault: false, lifecycle: 'available' });
    expect(row.operatorNotifiedAt).not.toBeNull();

    sendOpsAlertMock.mockClear();
    await sync([id], new Date(t0.getTime() + 24 * HOURS));
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });

  runDb('an undelivered alert is retried on the next sync', async () => {
    const id = `${PREFIX}-retry`;
    sendOpsAlertMock.mockResolvedValueOnce(false);
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    expect(await sync([id], t0)).toMatchObject({ operatorNotified: false });
    expect((await getPlatformModelByModelId(id))!.operatorNotifiedAt).toBeNull();
    await sync([id], new Date(t0.getTime() + 24 * HOURS));
    expect((await getPlatformModelByModelId(id))!.operatorNotifiedAt).not.toBeNull();
  });

  runDb('missing needs 3 successful syncs AND 48 h; three quick refreshes do not hide a model', async () => {
    const keep = `${PREFIX}-keep`;
    const gone = `${PREFIX}-gone`;
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    await sync([keep, gone], t0);
    for (let i = 1; i <= 3; i += 1) await sync([keep], new Date(t0.getTime() + i * 60_000)); // refresh spam
    expect((await getPlatformModelByModelId(gone))!.lifecycle).toBe('available');
    const report = await sync([keep], new Date(t0.getTime() + 49 * HOURS));
    expect(report).toMatchObject({ status: 'ok', markedMissing: [gone] });
    expect((await getPlatformModelByModelId(gone))!.lifecycle).toBe('missing');
    expect(sendOpsAlertMock).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining(gone) }));
  });

  runDb('a model that reappears is restored to available', async () => {
    const id = `${PREFIX}-back`;
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    await sync([id], t0);
    await withSystemDbAccessContext(() => db.update(aiPlatformModels).set({ lifecycle: 'missing', missedSyncCount: 3 }).where(inArray(aiPlatformModels.modelId, [id])));
    expect(await sync([id], new Date(t0.getTime() + 72 * HOURS))).toMatchObject({ restored: [id] });
    expect((await getPlatformModelByModelId(id))!).toMatchObject({ lifecycle: 'available', missedSyncCount: 0 });
  });

  runDb('seeded rows no sync has seen are never marked missing, however often they are absent', async () => {
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    for (let i = 0; i < 4; i += 1) await sync([`${PREFIX}-only`], new Date(t0.getTime() + i * 72 * HOURS));
    for (const seeded of SEEDED_PLATFORM_MODELS) {
      const row = (await getPlatformModelByModelId(seeded.modelId))!;
      expect(row.lifecycle, seeded.modelId).toBe('available');
      expect(row.missedSyncCount, seeded.modelId).toBe(0);
    }
  });

  // Review gap (PR #7643): the only operator signal before every platform-key
  // chat would resolve to a dead default.
  runDb('the platform default going missing is reported in the operator alert', async () => {
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    const restore = { lifecycle: 'available' as const, missedSyncCount: 0, lastSeenAt: null, updatedAt: t0 };
    try {
      await withSystemDbAccessContext(() => db.update(aiPlatformModels)
        .set({ lastSeenAt: new Date(t0.getTime() - 49 * HOURS), missedSyncCount: 2 })
        .where(sql`model_id = 'claude-sonnet-5-5'`));
      const report = await sync([`${PREFIX}-other`], t0);
      expect(report).toMatchObject({ status: 'ok' });
      expect(report.status === 'ok' && report.markedMissing).toContain('claude-sonnet-5-5');
      expect(sendOpsAlertMock).toHaveBeenLastCalledWith(expect.objectContaining({
        body: expect.stringContaining('The platform default model claude-sonnet-5-5 is missing'),
      }));
    } finally {
      await withSystemDbAccessContext(() => db.update(aiPlatformModels).set(restore).where(sql`model_id = 'claude-sonnet-5-5'`));
    }
  });

  runDb('a skipped sync (gateway base URL) changes no row', async () => {
    const before = await withSystemDbAccessContext(() => db.select({ n: sql<number>`count(*)::int` }).from(aiPlatformModels));
    expect(await syncPlatformModels({ env: { ...ENV, ANTHROPIC_BASE_URL: 'http://localhost:8000' }, discover: async () => listed(`${PREFIX}-x`) }))
      .toEqual({ status: 'skipped', reason: 'custom_base_url' });
    const after = await withSystemDbAccessContext(() => db.select({ n: sql<number>`count(*)::int` }).from(aiPlatformModels));
    expect(after).toEqual(before);
  });
});
