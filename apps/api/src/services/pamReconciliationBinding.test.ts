import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock('../db', () => ({ db: { execute: mocks.execute } }));

import { resolvePamReconciliationBindings } from './pamReconciliationBinding';

const input = {
  agentId: 'agent-primary',
  deviceId: '10000000-0000-4000-8000-000000000001',
  orgId: '10000000-0000-4000-8000-000000000002',
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

  it('performs no database read for an empty internal batch', async () => {
    await expect(resolvePamReconciliationBindings({ ...input, candidates: [] })).resolves.toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
