/**
 * #10428 (W05 Task 5) — the chip's status read and DTO shape. The group writes
 * run against real RLS in integration/wispInstructionCaptures.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  readInstructionCapture: vi.fn(),
  listCapturedInstructionBlocks: vi.fn(),
  deviceRows: [] as Array<{ id: string; orgId: string; orgName: string }>,
}));

vi.mock('./instructionCaptureStatus', () => ({ readInstructionCapture: h.readInstructionCapture }));
vi.mock('./memoryService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./memoryService')>()),
  listCapturedInstructionBlocks: h.listCapturedInstructionBlocks,
}));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'innerJoin', 'where']) chain[m] = () => chain;
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve(h.deviceRows).then(res);
      return chain;
    }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
}));

import type { AuthContext } from '../../middleware/auth';
import { captureStatus, listCapturedInstructions } from './instructionCaptures';
import { MemoryServiceError } from './memoryService';

const USER = 'u-1';
const auth = { user: { id: USER } } as unknown as AuthContext;
const ORG = '22222222-2222-4222-8222-222222222222';
const ORG2 = '23232323-2323-4323-8323-232323232323';
const DEV1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEV2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INSTR = '88888888-8888-4888-8888-888888888888';

function entry(over: Record<string, unknown> = {}, block: Record<string, unknown> = {}, supersededByOwnerKind: string | null = null) {
  return {
    block: {
      id: crypto.randomUUID(), status: 'unconfirmed', supersededById: null, createdAt: new Date('2027-02-01T10:00:00.000Z'),
      content: {
        instructionId: INSTR, effect: 'deny', verb: 'reboot', deviceId: DEV1, condition: null, until: null,
        text: "don't reboot PC-01", targetLabels: ['PC-01', 'PC-02'], sourceMessageId: null,
        captureId: '99999999-9999-4999-8999-999999999999', ...over,
      },
      ...block,
    },
    supersededByOwnerKind,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.deviceRows = [{ id: DEV1, orgId: ORG, orgName: 'Acme' }, { id: DEV2, orgId: ORG, orgName: 'Acme' }];
});

describe('captureStatus', () => {
  it('an unknown or expired capture is not_found', async () => {
    h.readInstructionCapture.mockResolvedValue(null);
    await expect(captureStatus(auth, 'c-1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(captureStatus(auth, 'c-1')).rejects.toBeInstanceOf(MemoryServiceError);
  });

  it("someone else's capture is not_found", async () => {
    h.readInstructionCapture.mockResolvedValue({ status: 'saved', userId: 'u-2', sessionId: 's-1' });
    await expect(captureStatus(auth, 'c-1')).rejects.toMatchObject({ code: 'not_found' });
    expect(h.listCapturedInstructionBlocks).not.toHaveBeenCalled();
  });

  it('pending reports no instructions yet, without a read', async () => {
    h.readInstructionCapture.mockResolvedValue({ status: 'pending', userId: USER, sessionId: 's-1' });
    await expect(captureStatus(auth, 'c-1')).resolves.toEqual({ status: 'pending', instructions: [] });
    expect(h.listCapturedInstructionBlocks).not.toHaveBeenCalled();
  });

  it('saved returns the capture\'s instructions', async () => {
    h.readInstructionCapture.mockResolvedValue({ status: 'saved', userId: USER, sessionId: 's-1' });
    h.listCapturedInstructionBlocks.mockResolvedValue([entry(), entry({ deviceId: DEV2 })]);
    const res = await captureStatus(auth, 'c-1');
    expect(h.listCapturedInstructionBlocks).toHaveBeenCalledWith(auth, { captureId: 'c-1' });
    expect(res.instructions).toEqual([{
      instructionId: INSTR, captureId: '99999999-9999-4999-8999-999999999999', capturedAt: '2027-02-01T10:00:00.000Z', text: "don't reboot PC-01", status: 'unconfirmed', enforceable: true, verb: 'reboot',
      targetLabels: ['PC-01', 'PC-02'], until: null, orgId: ORG, orgName: 'Acme', unmatched: false, keptForOrg: false,
    }]);
  });
});

describe('the chip DTO', () => {
  it('a conditional deny is not enforceable (the chip shows no enforced form)', async () => {
    h.listCapturedInstructionBlocks.mockResolvedValue([entry({ condition: 'during business hours' })]);
    const [dto] = await listCapturedInstructions(auth, 's-1');
    expect(dto!.enforceable).toBe(false);
  });

  it('targets across two orgs leave orgId null (Keep for everyone hidden)', async () => {
    h.deviceRows = [{ id: DEV1, orgId: ORG, orgName: 'Acme' }, { id: DEV2, orgId: ORG2, orgName: 'Beta' }];
    h.listCapturedInstructionBlocks.mockResolvedValue([entry(), entry({ deviceId: DEV2 })]);
    const [dto] = await listCapturedInstructions(auth, 's-1');
    expect(dto).toMatchObject({ orgId: null, orgName: null });
  });

  it('a device the caller cannot see leaves orgId null', async () => {
    h.deviceRows = [{ id: DEV1, orgId: ORG, orgName: 'Acme' }];
    h.listCapturedInstructionBlocks.mockResolvedValue([entry(), entry({ deviceId: DEV2 })]);
    const [dto] = await listCapturedInstructions(auth, 's-1');
    expect(dto!.orgId).toBeNull();
  });

  it('an unmatched note is flagged and never enforceable', async () => {
    h.listCapturedInstructionBlocks.mockResolvedValue([entry({ deviceId: null })]);
    const [dto] = await listCapturedInstructions(auth, 's-1');
    expect(dto).toMatchObject({ unmatched: true, enforceable: false, orgId: null });
  });

  it('a group replaced by a newer capture of the same clause is dropped; one shared with the org shows kept', async () => {
    const other = '77777777-7777-4777-8777-777777777777';
    h.listCapturedInstructionBlocks.mockResolvedValue([
      entry({}, { supersededById: 'x', status: 'unconfirmed' }, 'user'),
      entry({ instructionId: other }, { supersededById: 'y', status: 'unconfirmed' }, 'org'),
    ]);
    const dtos = await listCapturedInstructions(auth, 's-1');
    expect(dtos).toEqual([expect.objectContaining({ instructionId: other, keptForOrg: true, status: 'confirmed' })]);
  });

  it('content that does not parse is skipped, never shown', async () => {
    h.listCapturedInstructionBlocks.mockResolvedValue([{ block: { content: { text: 'free' }, supersededById: null, status: 'unconfirmed', createdAt: new Date() }, supersededByOwnerKind: null }]);
    expect(await listCapturedInstructions(auth, 's-1')).toEqual([]);
  });
});
