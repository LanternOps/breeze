import { describe, expect, it, vi } from 'vitest';

// Every assertion below fails BEFORE any DB work (ownership and shape checks
// run first, deliberately), so the db module only needs to exist.
// importOriginal spread: the module also exports the DB-context helpers
// (runOutsideDbContext, withDbAccessContext) that commandQueue captures at
// import time through automationRuntime -> scriptDispatch.
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(async () => {
      throw new Error('transaction should not be reached in these cases');
    }),
  },
}));

import {
  createMonitorDefinition,
  MonitorOwnershipError,
  MonitorValidationError,
} from './monitorService';
import type { AuthContext } from '../../middleware/auth';
import type { CreateMonitorDefinitionInput } from '@breeze/shared';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: 'user',
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    partnerOrgAccess: null,
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => orgId === ORG,
    ...overrides,
  } as unknown as AuthContext;
}

function input(overrides: Partial<CreateMonitorDefinitionInput> = {}): CreateMonitorDefinitionInput {
  return {
    ownerScope: 'organization',
    name: 'CPU high',
    kind: 'cpu',
    enabled: true,
    condition: { operator: 'gt', value: 90 },
    severity: 'high',
    cooldownMinutes: 5,
    autoResolve: false,
    responses: [],
    deliveryMode: 'inherit',
    deliveryChannelIds: [],
    recurrenceActions: [],
    pauseResponsesOnEscalation: true,
    ...overrides,
  } as CreateMonitorDefinitionInput;
}

describe('monitorService ownership + validation (#5289)', () => {
  it('an org-scoped caller cannot create a partner-wide monitor', async () => {
    await expect(
      createMonitorDefinition(input({ ownerScope: 'partner' }), auth()),
    ).rejects.toBeInstanceOf(MonitorOwnershipError);
  });

  it('a partner-scoped caller without full org access cannot create a partner-wide monitor', async () => {
    await expect(
      createMonitorDefinition(
        input({ ownerScope: 'partner' }),
        auth({ scope: 'partner', partnerOrgAccess: 'selected' }),
      ),
    ).rejects.toBeInstanceOf(MonitorOwnershipError);
  });

  it('a caller cannot create a monitor in an org it cannot access', async () => {
    await expect(
      createMonitorDefinition(
        input({ orgId: '33333333-3333-4333-8333-333333333333' }),
        auth(),
      ),
    ).rejects.toBeInstanceOf(MonitorOwnershipError);
  });

  it('rejects a condition that does not match the kind', async () => {
    await expect(
      createMonitorDefinition(input({ condition: { withinDays: 14 } }), auth()),
    ).rejects.toBeInstanceOf(MonitorValidationError);
  });

  it('rejects an out-of-range condition value', async () => {
    await expect(
      createMonitorDefinition(input({ condition: { operator: 'gt', value: 900 } }), auth()),
    ).rejects.toBeInstanceOf(MonitorValidationError);
  });

  it('rejects an ai_triage response with no ai agent', async () => {
    await expect(
      createMonitorDefinition(
        input({ responses: [{ type: 'ai_triage' }] as CreateMonitorDefinitionInput['responses'] }),
        auth(),
      ),
    ).rejects.toBeInstanceOf(MonitorValidationError);
  });
});
