import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectQueue, insertImpl, transactionSpy } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  insertImpl: { current: null as null | ((values: Record<string, unknown>) => unknown) },
  transactionSpy: vi.fn(),
}));

/**
 * The snapshot loader issues its two SELECTs inside ONE
 * `runOutsideDbContext(() => withSystemDbAccessContext(...))`, and every write
 * goes through a NESTED `db.transaction` so a failing row rolls back to its own
 * savepoint. Both shapes are modelled here so a change to either is visible as
 * a test failure rather than as an undetected behaviour change.
 */
function chainable(result: unknown[]) {
  const thenable = {
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return { from: () => ({ where: () => thenable }) };
}

vi.mock('../../../db', () => ({
  db: {
    select: vi.fn(() => chainable(selectQueue.shift() ?? [])),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => {
      transactionSpy();
      const tx = {
        insert: () => ({
          values: (values: Record<string, unknown>) => ({
            returning: async () => {
              if (!insertImpl.current) throw new Error('no insert impl queued');
              return insertImpl.current(values);
            },
          }),
        }),
      };
      return cb(tx);
    },
  },
  runOutsideDbContext: <T>(fn: () => Promise<T>) => fn(),
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('../../../db/schema', () => ({
  customFieldDefinitions: {
    id: 'id',
    orgId: 'orgId',
    partnerId: 'partnerId',
    fieldKey: 'fieldKey',
    type: 'type',
  },
  organizations: { id: 'id', partnerId: 'partnerId', deletedAt: 'deletedAt' },
}));

import {
  commitCustomFieldDefinitionImport,
  previewCustomFieldDefinitionImport,
  type DefinitionImportContext,
} from './definitionImport';
import type { CustomFieldDefinitionImportRow, CustomFieldType } from './types';

const PARTNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG = '11111111-1111-4111-8111-111111111111';
const FOREIGN_ORG = '22222222-2222-4222-8222-222222222222';
const DEF_A = '33333333-3333-4333-8333-333333333333';
const DEF_B = '44444444-4444-4444-8444-444444444444';
const NEW_ID = '55555555-5555-4555-8555-555555555555';

const ctx: DefinitionImportContext = {
  partnerId: PARTNER,
  accessibleOrgIds: [ORG],
  canManagePartnerWide: true,
};

const actor = { userId: 'u-1' };

interface SeedDefinition {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  fieldKey: string;
  type: CustomFieldType;
}

/** Queue the two SELECT results the snapshot loader consumes, in order. */
function seed(definitions: SeedDefinition[], orgIds: string[] = [ORG]) {
  selectQueue.length = 0;
  selectQueue.push(orgIds.map((id) => ({ id })));
  selectQueue.push(definitions);
}

function partnerDefinition(fieldKey: string, type: CustomFieldType, id = DEF_A): SeedDefinition {
  return { id, orgId: null, partnerId: PARTNER, fieldKey, type };
}

function orgDefinition(
  fieldKey: string,
  type: CustomFieldType,
  id = DEF_B,
  orgId = ORG,
): SeedDefinition {
  return { id, orgId, partnerId: null, fieldKey, type };
}

function row(overrides: Partial<CustomFieldDefinitionImportRow> = {}): CustomFieldDefinitionImportRow {
  return { fieldKey: 'udf7', name: 'Warranty Expiry', type: 'date', ownerScope: 'partner', ...overrides };
}

beforeEach(() => {
  selectQueue.length = 0;
  insertImpl.current = (values) => [{ id: NEW_ID, ...values }];
  transactionSpy.mockClear();
});

describe('previewCustomFieldDefinitionImport', () => {
  it('annotates an unseen key as create', async () => {
    seed([]);
    const [r] = await previewCustomFieldDefinitionImport([row()], ctx);
    expect(r).toMatchObject({ annotation: 'create', existingId: null, existingType: null });
  });

  it('annotates a key that already exists with the SAME type as already-exists', async () => {
    seed([partnerDefinition('udf7', 'date')]);
    const [r] = await previewCustomFieldDefinitionImport([row({ name: 'Warranty' })], ctx);
    expect(r).toMatchObject({ annotation: 'already-exists', existingId: DEF_A, existingType: 'date' });
  });

  it('annotates a differing type as type-conflict, never a silent cast', async () => {
    seed([partnerDefinition('udf7', 'text')]);
    const [r] = await previewCustomFieldDefinitionImport([row()], ctx);
    expect(r).toMatchObject({ annotation: 'type-conflict', existingType: 'text' });
  });

  it('annotates an org-owned key that shadows a partner-wide one as key-shadowed', async () => {
    seed([partnerDefinition('udf7', 'text')]);
    const [r] = await previewCustomFieldDefinitionImport(
      [row({ name: 'Local', type: 'text', ownerScope: 'organization', organizationId: ORG })],
      ctx,
    );
    expect(r!.annotation).toBe('key-shadowed');
  });

  it('annotates a partner-wide key that shadows an org-owned one as key-shadowed', async () => {
    seed([orgDefinition('udf7', 'text')]);
    const [r] = await previewCustomFieldDefinitionImport([row({ type: 'text' })], ctx);
    expect(r!.annotation).toBe('key-shadowed');
  });

  it('refuses a partner-wide row from a caller without the capability, at PREVIEW', async () => {
    seed([]);
    const [r] = await previewCustomFieldDefinitionImport([row()], { ...ctx, canManagePartnerWide: false });
    // NOT `org-not-found`: that copy would send a tech looking for a missing
    // organization when the truth is a missing capability.
    expect(r!.annotation).toBe('partner-wide-denied');
  });

  it('reports an org outside the caller reach as org-not-found, never an existence oracle', async () => {
    seed([]);
    const [r] = await previewCustomFieldDefinitionImport(
      [row({ fieldKey: 'a', name: 'A', type: 'text', ownerScope: 'organization', organizationId: FOREIGN_ORG })],
      ctx,
    );
    expect(r!.annotation).toBe('org-not-found');
  });

  it('reports an organization row with no organizationId as org-not-found', async () => {
    seed([]);
    const [r] = await previewCustomFieldDefinitionImport(
      [{ fieldKey: 'a', name: 'A', type: 'text', ownerScope: 'organization' }],
      ctx,
    );
    expect(r!.annotation).toBe('org-not-found');
  });

  it('detects a duplicate key WITHIN the submitted batch', async () => {
    seed([]);
    const rows = await previewCustomFieldDefinitionImport(
      [row({ name: 'A', type: 'text' }), row({ name: 'B', type: 'text' })],
      ctx,
    );
    expect(rows[0]!.annotation).toBe('create');
    expect(rows[1]).toMatchObject({ annotation: 'type-conflict' });
    expect(rows[1]!.conflictReason).toMatch(/appears more than once/i);
  });

  it('detects a CROSS-AXIS duplicate within the submitted batch as key-shadowed', async () => {
    seed([]);
    const rows = await previewCustomFieldDefinitionImport(
      [row({ type: 'text' }), row({ type: 'text', ownerScope: 'organization', organizationId: ORG })],
      ctx,
    );
    expect(rows[1]!.annotation).toBe('key-shadowed');
  });

  it('never resolves a row against an organization outside the caller reach', async () => {
    // The snapshot is bounded by partnerId AND accessibleOrgIds; a foreign org
    // is not in it, so the row can only ever be `org-not-found`.
    seed([orgDefinition('udf7', 'text', DEF_B, ORG)], [ORG]);
    const [r] = await previewCustomFieldDefinitionImport(
      [row({ type: 'text', ownerScope: 'organization', organizationId: FOREIGN_ORG })],
      ctx,
    );
    expect(r!.annotation).toBe('org-not-found');
  });
});

describe('commitCustomFieldDefinitionImport', () => {
  it('creates a partner-wide definition and reports it', async () => {
    seed([]);
    const s = await commitCustomFieldDefinitionImport([{ ...row(), expectedAnnotation: 'create' }], ctx, actor);
    expect(s.errors).toHaveLength(0);
    expect(s.created).toHaveLength(1);
    expect(s.created[0]).toMatchObject({ fieldKey: 'udf7', ownerScope: 'partner', organizationId: null });
  });

  it('writes every row inside a nested transaction so one failure cannot poison the request', async () => {
    seed([]);
    await commitCustomFieldDefinitionImport([{ ...row(), expectedAnnotation: 'create' }], ctx, actor);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a row whose annotation moved since preview', async () => {
    seed([partnerDefinition('udf7', 'date')]);
    const s = await commitCustomFieldDefinitionImport(
      [{ ...row(), name: 'Warranty', expectedAnnotation: 'create' }],
      ctx,
      actor,
    );
    expect(s.errors[0]).toMatchObject({ code: 'annotation-changed' });
    expect(s.created).toHaveLength(0);
  });

  it('refuses an already-exists acknowledgement pinned to a DIFFERENT definition', async () => {
    seed([partnerDefinition('udf7', 'date', DEF_A)]);
    const s = await commitCustomFieldDefinitionImport(
      [{ ...row(), name: 'W', expectedAnnotation: 'already-exists', expectedDefinitionId: DEF_B }],
      ctx,
      actor,
    );
    expect(s.errors[0]).toMatchObject({ code: 'match-changed' });
    expect(s.skipped).toHaveLength(0);
  });

  it('is idempotent: re-running an identical file creates nothing', async () => {
    seed([partnerDefinition('udf7', 'date', DEF_A)]);
    const again = await commitCustomFieldDefinitionImport(
      [{ ...row(), name: 'W', expectedAnnotation: 'already-exists', expectedDefinitionId: DEF_A }],
      ctx,
      actor,
    );
    expect(again.created).toHaveLength(0);
    expect(again.skipped).toEqual([
      { index: 0, definitionId: DEF_A, fieldKey: 'udf7', reason: 'already-exists' },
    ]);
  });

  it('refuses a partner-wide row from a caller without the capability', async () => {
    seed([]);
    const s = await commitCustomFieldDefinitionImport(
      [{ ...row(), expectedAnnotation: 'create' }],
      { ...ctx, canManagePartnerWide: false },
      actor,
    );
    expect(s.errors[0]).toMatchObject({ code: 'partner-wide-denied' });
    expect(s.created).toHaveLength(0);
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('refuses an organization row naming an org outside the caller reach', async () => {
    seed([]);
    const s = await commitCustomFieldDefinitionImport(
      [{ ...row(), ownerScope: 'organization', organizationId: FOREIGN_ORG, expectedAnnotation: 'create' }],
      ctx,
      actor,
    );
    expect(s.errors[0]).toMatchObject({ code: 'org-not-found' });
    expect(transactionSpy).not.toHaveBeenCalled();
  });

  it('turns a 23505 into a typed write-failed with FIXED copy, never the driver message', async () => {
    seed([]);
    insertImpl.current = () => {
      throw Object.assign(
        new Error(
          'duplicate key value violates unique constraint "custom_field_definitions_partner_key_uq" '
            + 'DETAIL: Key (partner_id, field_key)=(p, udf7) already exists.',
        ),
        { code: '23505' },
      );
    };
    const s = await commitCustomFieldDefinitionImport([{ ...row(), expectedAnnotation: 'create' }], ctx, actor);
    expect(s.errors[0]!.code).toBe('write-failed');
    expect(s.errors[0]!.error).not.toMatch(/DETAIL|constraint/);
    expect(s.errors[0]!.error).toMatch(/already exists/i);
  });

  it('surfaces the anti-shadowing trigger P0001 as key-shadowed', async () => {
    seed([]);
    insertImpl.current = () => {
      throw Object.assign(
        new Error('custom field key "udf7" already exists as an all-organizations field for this partner'),
        { code: 'P0001' },
      );
    };
    const s = await commitCustomFieldDefinitionImport([{ ...row(), expectedAnnotation: 'create' }], ctx, actor);
    expect(s.errors[0]!.code).toBe('key-shadowed');
  });

  it('never serializes the driver error onto the response body', async () => {
    seed([]);
    insertImpl.current = () => {
      throw Object.assign(new Error('boom: select * from custom_field_definitions'), { code: '23514' });
    };
    const s = await commitCustomFieldDefinitionImport([{ ...row(), expectedAnnotation: 'create' }], ctx, actor);
    expect(JSON.stringify(s)).not.toMatch(/boom/);
    // …but the original error is still reachable in-process for error tracking.
    expect((s.errors[0] as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it('never lets a row land in more than one of created / skipped / errors', async () => {
    seed([partnerDefinition('udf8', 'text', DEF_A)]);
    const s = await commitCustomFieldDefinitionImport(
      [
        { ...row(), expectedAnnotation: 'create' },
        {
          ...row({ fieldKey: 'udf8', name: 'B', type: 'text' }),
          expectedAnnotation: 'already-exists',
          expectedDefinitionId: DEF_A,
        },
        {
          ...row({
            fieldKey: 'udf9',
            name: 'C',
            type: 'text',
            ownerScope: 'organization',
            organizationId: FOREIGN_ORG,
          }),
          expectedAnnotation: 'create',
        },
      ],
      ctx,
      actor,
    );
    const seen = [...s.created, ...s.skipped, ...s.errors].map((e) => e.index);
    expect(seen.slice().sort()).toEqual([0, 1, 2]);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
