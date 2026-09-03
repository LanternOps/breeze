import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  inserted: vi.fn(),
  selected: vi.fn(),
  where: undefined as SQL | undefined,
  conflict: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values) => {
        state.inserted(values);
        return {
          onConflictDoNothing: vi.fn((config) => {
            state.conflict(config);
            return Promise.resolve();
          }),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((where: SQL) => {
          state.where = where;
          return state.selected();
        }),
      })),
    })),
  },
}));

import { provisionPortalReportDefinitions } from './reportsSelfService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

describe('provisionPortalReportDefinitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.where = undefined;
    state.selected.mockResolvedValue([
      { type: 'executive_summary' },
      { type: 'security_compliance_posture' },
    ]);
  });

  it('inserts the two fixed customer-safe definitions idempotently', async () => {
    await provisionPortalReportDefinitions({
      orgId: ORG_ID,
      createdBy: USER_ID,
    });

    expect(state.inserted).toHaveBeenCalledWith([
      expect.objectContaining({
        orgId: ORG_ID,
        name: 'Customer portal — Executive summary',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
        createdBy: USER_ID,
        executionScopeKind: 'unrestricted',
        executionScopeUserId: USER_ID,
        executionScopePrincipalKind: 'user',
      }),
      expect.objectContaining({
        orgId: ORG_ID,
        name: 'Customer portal — Security & compliance posture',
        type: 'security_compliance_posture',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
        createdBy: USER_ID,
        executionScopeKind: 'unrestricted',
        executionScopeUserId: USER_ID,
        executionScopePrincipalKind: 'user',
      }),
    ]);
    expect(state.conflict).toHaveBeenCalledOnce();
  });

  it('re-selects definitions through an organization-scoped predicate', async () => {
    await provisionPortalReportDefinitions({ orgId: ORG_ID, createdBy: USER_ID });

    const query = new PgDialect().sqlToQuery(state.where as SQL);
    expect(query.sql).toContain('"reports"."org_id" = $1');
    expect(query.sql).toContain('"reports"."portal_self_service" = $2');
    expect(query.params).toEqual([ORG_ID, true]);
  });

  it('fails when either canonical definition is still absent after insertion', async () => {
    state.selected.mockResolvedValue([{ type: 'executive_summary' }]);

    await expect(provisionPortalReportDefinitions({
      orgId: ORG_ID,
      createdBy: USER_ID,
    })).rejects.toThrow(
      'Failed to provision portal report definition security_compliance_posture',
    );
  });
});
