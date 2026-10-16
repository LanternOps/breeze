import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock('../db', () => ({ db: { execute: mocks.execute } }));

import { resolvePamReconciliationBindings, toV1Disposition } from './pamReconciliationBinding';

const input = {
  agentId: 'agent-primary',
  deviceId: '10000000-0000-4000-8000-000000000001',
  protocolVersion: 2,
  candidates: [
    {
      observationId: '20000000-0000-4000-8000-000000000001',
      actuationId: '30000000-0000-4000-8000-000000000001',
      generation: 3,
    },
    {
      observationId: '20000000-0000-4000-8000-000000000002',
      actuationId: '30000000-0000-4000-8000-000000000002',
      generation: 4,
    },
    {
      observationId: '20000000-0000-4000-8000-000000000003',
      actuationId: '30000000-0000-4000-8000-000000000003',
      generation: 1,
    },
    {
      observationId: '20000000-0000-4000-8000-000000000004',
      actuationId: '30000000-0000-4000-8000-000000000004',
      generation: 9,
    },
  ],
} as const;

describe('resolvePamReconciliationBindings', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns the one-read dispositions in original candidate order', async () => {
    mocks.execute.mockResolvedValue({
      rows: [
        {
          ordinal: 3,
          observation_id: input.candidates[2].observationId,
          status: 'stale',
          command_id: null,
        },
        {
          ordinal: 1,
          observation_id: input.candidates[0].observationId,
          status: 'bound',
          command_id: '40000000-0000-4000-8000-000000000001',
        },
        {
          ordinal: 4,
          observation_id: input.candidates[3].observationId,
          status: 'unresolved',
          command_id: null,
        },
        {
          ordinal: 2,
          observation_id: input.candidates[1].observationId,
          status: 'duplicate',
          command_id: null,
        },
      ],
    });

    await expect(resolvePamReconciliationBindings(input)).resolves.toEqual([
      {
        status: 'bound',
        observationId: input.candidates[0].observationId,
        commandId: '40000000-0000-4000-8000-000000000001',
      },
      { status: 'duplicate', observationId: input.candidates[1].observationId },
      { status: 'stale', observationId: input.candidates[2].observationId },
      { status: 'unresolved', observationId: input.candidates[3].observationId },
    ]);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the database omits or contradicts a candidate row', async () => {
    mocks.execute.mockResolvedValue({
      rows: [
        {
          ordinal: 1,
          observation_id: input.candidates[0].observationId,
          status: 'bound',
          command_id: null,
        },
        {
          ordinal: 2,
          observation_id: input.candidates[1].observationId,
          status: 'unknown',
          command_id: null,
        },
      ],
    });

    const result = await resolvePamReconciliationBindings(input);

    expect(result).toEqual(input.candidates.map((candidate) => ({
      status: 'unresolved',
      observationId: candidate.observationId,
    })));
  });

  // PAM ownership epochs W3 (#8205).
  it('passes retired through on v2 and maps it to stale on v1', async () => {
    const rows = input.candidates.map((candidate, index) => ({
      ordinal: index + 1,
      observation_id: candidate.observationId,
      status: index === 0 ? 'retired' : 'unresolved',
      command_id: null,
    }));
    mocks.execute.mockResolvedValue({ rows });

    const v2 = await resolvePamReconciliationBindings({ ...input, protocolVersion: 2 });
    expect(v2[0]).toEqual({ status: 'retired', observationId: input.candidates[0].observationId });

    const v1 = await resolvePamReconciliationBindings({ ...input, protocolVersion: 1 });
    expect(v1[0]).toEqual({ status: 'stale', observationId: input.candidates[0].observationId });
    expect(v1.map((item) => item.status)).not.toContain('retired');
  });

  it('fails the whole batch closed when a retired row carries a command id', async () => {
    mocks.execute.mockResolvedValue({
      rows: input.candidates.map((candidate, index) => ({
        ordinal: index + 1,
        observation_id: candidate.observationId,
        status: index === 0 ? 'retired' : 'unresolved',
        command_id: index === 0 ? '40000000-0000-4000-8000-000000000001' : null,
      })),
    });
    const result = await resolvePamReconciliationBindings(input);
    expect(result.every((item) => item.status === 'unresolved')).toBe(true);
  });

  it('calls only the lineage definer function', async () => {
    mocks.execute.mockResolvedValue({ rows: [] });
    await resolvePamReconciliationBindings(input);
    const query = mocks.execute.mock.calls[0]![0] as { queryChunks?: Array<{ value?: string[] }> };
    const text = (query.queryChunks ?? []).flatMap((chunk) => chunk.value ?? []).join('');
    expect(text).toContain('public.breeze_pam_epoch_binding(');
    expect(text).not.toContain('JOIN devices');
  });

  it('toV1Disposition leaves every v1 disposition unchanged', () => {
    const observationId = input.candidates[0].observationId;
    const bound = { status: 'bound' as const, observationId, commandId: '40000000-0000-4000-8000-000000000001' };
    expect(toV1Disposition(bound)).toBe(bound);
    for (const status of ['duplicate', 'stale', 'unresolved'] as const) {
      expect(toV1Disposition({ status, observationId })).toEqual({ status, observationId });
    }
    expect(toV1Disposition({ status: 'retired', observationId })).toEqual({ status: 'stale', observationId });
  });

  it('performs no database read for an empty internal batch', async () => {
    await expect(resolvePamReconciliationBindings({ ...input, candidates: [] })).resolves.toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
