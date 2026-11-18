import { describe, it, expect, vi, beforeEach } from 'vitest';

// #12140: a note written with no person approving it (the MCP server's Tier-2
// dispatch pins `unattendedNoteWrite`) is bounded in size, expiry and, in the
// service, active notes per device. Without the flag nothing changes.

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(), getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(), resolveDeviceContext: vi.fn(),
}));

import { db } from '../db';
import { registerDeviceTools } from './aiToolsDevice';
import { createDeviceContext } from './brainDeviceContext';
import {
  UNATTENDED_NOTE_MAX_DETAILS_CHARS,
  UNATTENDED_NOTE_MAX_EXPIRY_DAYS,
} from './deviceNoteBounds';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const DEVICE = '22222222-2222-4222-8222-222222222222';
const DAY_MS = 86_400_000;
const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const createDeviceContextMock = createDeviceContext as unknown as ReturnType<typeof vi.fn>;

function handler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerDeviceTools(reg);
  return reg.get('set_device_context')!.handler;
}
function makeAuth(): AuthContext {
  return {
    principal: { kind: 'api_key' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}
const UNATTENDED = { unattendedNoteWrite: true as const };

/** `details` whose 2-space pretty JSON is exactly `chars` long. */
function detailsOfPrettyLength(chars: number): Record<string, unknown> {
  const overhead = JSON.stringify({ n: '' }, null, 2).length;
  const details = { n: 'x'.repeat(chars - overhead) };
  expect(JSON.stringify(details, null, 2).length).toBe(chars);
  return details;
}

describe('set_device_context — unattended note bounds (#12140)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: DEVICE, siteId: 's1', status: 'online' }]) }) }) });
    createDeviceContextMock.mockResolvedValue({ id: 'ctx-1' });
  });

  it('refuses details larger than the cap and writes nothing', async () => {
    const r = await handler()(
      { deviceId: DEVICE, contextType: 'issue', summary: 'note', details: detailsOfPrettyLength(UNATTENDED_NOTE_MAX_DETAILS_CHARS + 1) },
      makeAuth(), UNATTENDED,
    );
    expect(JSON.parse(r).error).toMatch(/details/);
    expect(JSON.parse(r).error).toContain(String(UNATTENDED_NOTE_MAX_DETAILS_CHARS));
    expect(createDeviceContextMock).not.toHaveBeenCalled();
  });

  it('accepts details exactly at the cap', async () => {
    const details = detailsOfPrettyLength(UNATTENDED_NOTE_MAX_DETAILS_CHARS);
    const r = await handler()({ deviceId: DEVICE, contextType: 'issue', summary: 'note', details }, makeAuth(), UNATTENDED);
    expect(r).toContain('Context recorded successfully');
    expect(createDeviceContextMock).toHaveBeenCalledWith(
      DEVICE, 'issue', 'note', details, expect.anything(), expect.any(Date), { unattended: true },
    );
  });

  it('refuses an expiry past the cap and writes nothing', async () => {
    const r = await handler()(
      { deviceId: DEVICE, contextType: 'followup', summary: 'note', expiresInDays: UNATTENDED_NOTE_MAX_EXPIRY_DAYS + 1 },
      makeAuth(), UNATTENDED,
    );
    expect(JSON.parse(r).error).toMatch(/expiresInDays/);
    expect(createDeviceContextMock).not.toHaveBeenCalled();
  });

  it('gives a note that names no expiry the capped expiry, and says so', async () => {
    const before = Date.now();
    const r = await handler()({ deviceId: DEVICE, contextType: 'quirk', summary: 'note' }, makeAuth(), UNATTENDED);
    const expiresAt = createDeviceContextMock.mock.calls[0]![5] as Date;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + UNATTENDED_NOTE_MAX_EXPIRY_DAYS * DAY_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + UNATTENDED_NOTE_MAX_EXPIRY_DAYS * DAY_MS);
    expect(r).toContain(`expires in ${UNATTENDED_NOTE_MAX_EXPIRY_DAYS} days`);
  });

  it('keeps a shorter expiry the caller named', async () => {
    const before = Date.now();
    await handler()({ deviceId: DEVICE, contextType: 'quirk', summary: 'note', expiresInDays: 3 }, makeAuth(), UNATTENDED);
    const expiresAt = createDeviceContextMock.mock.calls[0]![5] as Date;
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3 * DAY_MS);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3 * DAY_MS);
  });

  it('passes the service refusal (active-note cap) back to the caller', async () => {
    createDeviceContextMock.mockResolvedValue({ error: 'This device already has 8 active notes.' });
    const r = await handler()({ deviceId: DEVICE, contextType: 'issue', summary: 'note' }, makeAuth(), UNATTENDED);
    expect(JSON.parse(r).error).toContain('8 active notes');
  });

  it('checks device access before anything is counted or written', async () => {
    mockDb.select.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) });
    const r = await handler()({ deviceId: DEVICE, contextType: 'issue', summary: 'note' }, makeAuth(), UNATTENDED);
    expect(JSON.parse(r).error).toBeTruthy();
    expect(createDeviceContextMock).not.toHaveBeenCalled();
  });

  it('applies none of these bounds without the flag (an approved or in-app note)', async () => {
    const details = detailsOfPrettyLength(UNATTENDED_NOTE_MAX_DETAILS_CHARS * 10);
    const r = await handler()(
      { deviceId: DEVICE, contextType: 'preference', summary: 'note', details },
      makeAuth(),
    );
    expect(r).toContain('Context recorded successfully');
    expect(r).not.toContain('expires in');
    expect(createDeviceContextMock).toHaveBeenCalledWith(DEVICE, 'preference', 'note', details, expect.anything(), undefined, undefined);
  });
});
