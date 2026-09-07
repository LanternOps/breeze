import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeRouteAuditMock } = vi.hoisted(() => ({ writeRouteAuditMock: vi.fn() }));

vi.mock('../../auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { writeCustomFieldDefinitionImportAudits, writeCustomFieldValueImportAudits } from './audit';
import type {
  CustomFieldDefinitionImportRow,
  DefinitionImportSummary,
  ValueImportSummary,
} from './types';

const DEF_A = '33333333-3333-4333-8333-333333333333';
const DEF_B = '44444444-4444-4444-8444-444444444444';
const ORG = '11111111-1111-4111-8111-111111111111';
const D1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const D2 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';

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

/* ── W08: the values half (#4776) ─────────────────────────────────────────── */

function valueSummary(overrides: Partial<ValueImportSummary> = {}): ValueImportSummary {
  return {
    appliedValues: 2,
    skippedValues: 0,
    failedValues: 0,
    linksCreated: 1,
    errors: [],
    rows: [
      {
        index: 0,
        deviceId: D1,
        organizationId: ORG,
        method: 'hostname',
        externalSystem: 'datto_rmm',
        applied: 1,
        skipped: 0,
        failed: 0,
        appliedFieldKeys: ['asset_tag'],
        warranty: 'none',
        linkCreated: true,
      },
      {
        index: 1,
        deviceId: D2,
        organizationId: ORG,
        method: 'link',
        externalSystem: null,
        applied: 1,
        skipped: 0,
        failed: 0,
        appliedFieldKeys: [],
        warranty: 'applied',
        linkCreated: false,
      },
    ],
    ...overrides,
  };
}

describe('writeCustomFieldValueImportAudits', () => {
  it('audits every backfilled device with its resolution method', () => {
    writeCustomFieldValueImportAudits(c, { summary: valueSummary(), rowCount: 4, externalSystem: 'csv' });

    expect(writeRouteAuditMock).toHaveBeenCalledTimes(2);
    expect(writeRouteAuditMock.mock.calls[0]![1]).toEqual({
      orgId: ORG,
      action: 'device.custom_field.import',
      resourceType: 'device',
      resourceId: D1,
      details: {
        source: 'device_custom_field_import',
        externalSystem: 'datto_rmm',
        resolutionMethod: 'hostname',
        // Field KEYS only. A value can be anything the incumbent held and must
        // never enter an audit payload.
        changedFields: ['asset_tag'],
        warranty: 'none',
        linkCreated: true,
        rowCount: 4,
      },
    });
  });

  it("falls back to the batch's external system when the row named none", () => {
    writeCustomFieldValueImportAudits(c, { summary: valueSummary(), rowCount: 4, externalSystem: 'ninjaone' });
    expect(writeRouteAuditMock.mock.calls[1]![1]).toMatchObject({
      resourceId: D2,
      details: expect.objectContaining({ externalSystem: 'ninjaone', resolutionMethod: 'link', warranty: 'applied' }),
    });
  });

  it('never puts a VALUE in the payload — only field keys', () => {
    writeCustomFieldValueImportAudits(c, { summary: valueSummary(), rowCount: 4, externalSystem: 'csv' });
    const payload = JSON.stringify(writeRouteAuditMock.mock.calls.map((call) => call[1]));
    expect(payload).toContain('asset_tag');
    expect(payload).not.toMatch(/AB-1|serial|hostname"\s*:/i);
  });

  it('does not audit a row where nothing was applied', () => {
    // A row the commit left untouched (a re-import of an unchanged file) is not
    // a backfill; auditing it would bury the real writes on every re-run.
    const summary = valueSummary();
    summary.rows[0]!.applied = 0;
    summary.rows[1]!.applied = 0;

    writeCustomFieldValueImportAudits(c, { summary, rowCount: 4, externalSystem: 'csv' });

    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('still audits a row whose only change was the warranty target', () => {
    const summary = valueSummary({ rows: [] });
    summary.rows = [{
      index: 0, deviceId: D1, organizationId: ORG, method: 'serial', externalSystem: 'n_central',
      applied: 1, skipped: 0, failed: 0, appliedFieldKeys: [], warranty: 'applied', linkCreated: false,
    }];

    writeCustomFieldValueImportAudits(c, { summary, rowCount: 1, externalSystem: 'csv' });

    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditMock.mock.calls[0]![1]).toMatchObject({
      details: expect.objectContaining({ changedFields: [], warranty: 'applied', resolutionMethod: 'serial' }),
    });
  });

  it('writes nothing when the commit wrote nothing', () => {
    writeCustomFieldValueImportAudits(c, {
      summary: valueSummary({ rows: [], appliedValues: 0, linksCreated: 0 }),
      rowCount: 3,
      externalSystem: 'csv',
    });
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });
});
