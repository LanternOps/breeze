/**
 * `cloneScript` cuts the duplicate's v1 inside the same transaction as the row
 * and its tag copy (W01a Task 12). Tenancy resolution is covered by
 * scriptWrite.test.ts and the route suite; this file pins the version cut.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARTNER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SOURCE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '55555555-5555-4555-8555-555555555555';

const h = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  cuts: [] as Array<{ scriptId: string; provenance: Record<string, unknown> }>,
  source: null as Record<string, unknown> | null,
}));

vi.mock('../db', () => {
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        h.inserts.push(values);
        return { returning: vi.fn(() => Promise.resolve([{ id: 'clone-id', ...values }])) };
      }),
    })),
  };
  // `cloneScript` issues two module-level selects before the transaction: the
  // source row, then the source's tag names.
  let selectCall = 0;
  return {
    db: {
      select: vi.fn(() => {
        const call = selectCall++;
        const rows = call === 0 ? (h.source ? [h.source] : []) : [];
        const chain: Record<string, unknown> = {};
        for (const m of ['from', 'innerJoin', 'limit']) chain[m] = () => chain;
        chain.where = () => chain;
        (chain as { then: unknown }).then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
        return chain;
      }),
      transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    },
    __resetSelect: () => {
      selectCall = 0;
    },
  };
});

vi.mock('./scriptVersions', () => ({
  cutScriptVersion: vi.fn((_tx: unknown, args: { scriptId: string; provenance: Record<string, unknown> }) => {
    h.cuts.push(args);
    return Promise.resolve({ id: 'version-row', scriptId: args.scriptId, version: 1 });
  }),
}));

vi.mock('./scriptBundle', () => ({
  canReadScript: vi.fn(() => true),
  findSecretVariableReferences: vi.fn(() => Promise.resolve([])),
  findParameterSecretMismatches: vi.fn(() => Promise.resolve([])),
  describeSecretVariableRejection: vi.fn(() => 'secret'),
  describeParameterSecretMismatch: vi.fn(() => 'mismatch'),
  ensureTagIds: vi.fn(() => Promise.resolve([])),
  linkTags: vi.fn(() => Promise.resolve()),
}));

vi.mock('./scriptWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./scriptWrite')>();
  return {
    ...actual,
    resolveScriptCloneScope: vi.fn(() => ({ orgId: ORG_ID, partnerId: PARTNER_ID })),
  };
});

import { cloneScript } from './scriptClone';

const auth = {
  scope: 'organization',
  orgId: ORG_ID,
  partnerId: PARTNER_ID,
  accessibleOrgIds: [ORG_ID],
  canAccessOrg: (id: string) => id === ORG_ID,
  user: { id: USER_ID, email: 'c@example.com' },
} as unknown as Parameters<typeof cloneScript>[0];

beforeEach(async () => {
  h.inserts = [];
  h.cuts = [];
  h.source = {
    id: SOURCE_ID,
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    name: 'Source',
    description: null,
    category: null,
    osTypes: ['windows'],
    language: 'powershell',
    content: 'Write-Host hi',
    parameters: null,
    timeoutSeconds: 300,
    runAs: 'system',
    isSystem: false,
    exitCodeSeverityMapping: null,
    deletedAt: null,
  };
  const mod = (await import('../db')) as unknown as { __resetSelect: () => void };
  mod.__resetSelect();
});

describe('cloneScript cuts version 1', () => {
  it('inserts the duplicate at version 0', async () => {
    await cloneScript(auth, SOURCE_ID, {});
    expect(h.inserts[0]).toMatchObject({ version: 0 });
  });

  it('cuts exactly one human-origin version inside the same transaction', async () => {
    await cloneScript(auth, SOURCE_ID, {});
    expect(h.cuts).toHaveLength(1);
    expect(h.cuts[0]!.scriptId).toBe('clone-id');
    expect(h.cuts[0]!.provenance).toMatchObject({
      origin: 'human',
      changelog: 'Duplicated from another script',
      createdBy: USER_ID,
    });
  });

  it('returns the duplicate at version 1', async () => {
    const result = await cloneScript(auth, SOURCE_ID, {});
    expect(result).toMatchObject({ script: { version: 1 } });
  });
});
