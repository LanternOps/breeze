import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeRouteAuditMock } = vi.hoisted(() => ({ writeRouteAuditMock: vi.fn() }));

vi.mock('../../auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { writeCustomFieldDefinitionImportAudits } from './audit';
import type { CustomFieldDefinitionImportRow, DefinitionImportSummary } from './types';

const DEF_A = '33333333-3333-4333-8333-333333333333';
const DEF_B = '44444444-4444-4444-8444-444444444444';
const ORG = '11111111-1111-4111-8111-111111111111';

const c = {} as never;

const rows: CustomFieldDefinitionImportRow[] = [
  { fieldKey: 'udf7', name: 'Warranty Expiry', type: 'date', ownerScope: 'partner', sourceLabel: 'udf7' },
  { fieldKey: 'udf8', name: 'Asset Tag', type: 'text', ownerScope: 'organization', organizationId: ORG },
  { fieldKey: 'udf9', name: 'Unchanged', type: 'text', ownerScope: 'partner' },
];

const summary: DefinitionImportSummary = {
  created: [
    { index: 0, definitionId: DEF_A, fieldKey: 'udf7', ownerScope: 'partner', organizationId: null },
    { index: 1, definitionId: DEF_B, fieldKey: 'udf8', ownerScope: 'organization', organizationId: ORG },
  ],
  skipped: [{ index: 2, definitionId: 'def-x', fieldKey: 'udf9', reason: 'already-exists' }],
  errors: [],
};

beforeEach(() => writeRouteAuditMock.mockReset());

describe('writeCustomFieldDefinitionImportAudits', () => {
  it('writes one event per CREATED definition, and none for skipped rows', () => {
    writeCustomFieldDefinitionImportAudits(c, { summary, rows, externalSystem: 'datto_rmm' });
    // Three rows in, two created: a skipped row is a row the commit left
    // untouched, and auditing it would bury the real writes on every re-import.
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(2);
  });

  it('carries the provenance a post-migration dispute needs', () => {
    writeCustomFieldDefinitionImportAudits(c, { summary, rows, externalSystem: 'datto_rmm' });
    expect(writeRouteAuditMock.mock.calls[0]![1]).toEqual({
      orgId: null,
      action: 'custom_field.create',
      resourceType: 'custom_field',
      resourceId: DEF_A,
      resourceName: 'Warranty Expiry',
      details: {
        source: 'custom_field_definition_import',
        externalSystem: 'datto_rmm',
        // The incumbent's own name for the field. It is stored NOWHERE else —
        // there is no column for it — so this event is its only durable home.
        sourceLabel: 'udf7',
        fieldKey: 'udf7',
        ownerScope: 'partner',
        rowCount: 3,
      },
    });
  });

  it("attributes an org-owned definition to the row's own organization", () => {
    writeCustomFieldDefinitionImportAudits(c, { summary, rows, externalSystem: 'csv' });
    expect(writeRouteAuditMock.mock.calls[1]![1]).toMatchObject({
      orgId: ORG,
      resourceId: DEF_B,
      details: expect.objectContaining({ ownerScope: 'organization', externalSystem: 'csv' }),
    });
  });

  it('omits sourceLabel entirely when the row carried none', () => {
    writeCustomFieldDefinitionImportAudits(c, { summary, rows, externalSystem: 'csv' });
    expect(writeRouteAuditMock.mock.calls[1]![1].details).not.toHaveProperty('sourceLabel');
  });

  it('falls back to the field key when a created row cannot be matched back', () => {
    // Defensive: an index the caller did not supply a row for must still audit.
    writeCustomFieldDefinitionImportAudits(c, {
      summary: { ...summary, created: [{ index: 99, definitionId: DEF_A, fieldKey: 'udf7', ownerScope: 'partner', organizationId: null }] },
      rows,
      externalSystem: 'csv',
    });
    expect(writeRouteAuditMock.mock.calls[0]![1]).toMatchObject({ resourceName: 'udf7' });
  });

  it('writes nothing when the commit created nothing', () => {
    writeCustomFieldDefinitionImportAudits(c, {
      summary: { created: [], skipped: [], errors: [{ index: 0, fieldKey: 'udf7', error: 'x', code: 'type-conflict' }] },
      rows,
      externalSystem: 'csv',
    });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });
});
