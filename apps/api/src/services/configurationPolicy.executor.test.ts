import { describe, it, expect, vi } from 'vitest';

vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class AutomationReferenceAuthorizationError extends Error {
    readonly code = 'unknown_or_unauthorized_reference';
    constructor() {
      super('Unknown or unauthorized automation reference');
    }
  },
  resolveOwnedAutomationReferences: vi.fn(),
}));

vi.mock('./automationRuntime', () => ({
  normalizeAutomationActions: vi.fn((actions: unknown) => actions),
  resolveAutomationReferencesForOwner: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import {
  createConfigPolicy, updateConfigPolicy, addFeatureLink, updateFeatureLink,
  listFeatureLinks, assignPolicy,
} from './configurationPolicy';
import { db } from '../db';
import type { AuthContext } from '../middleware/auth';

function chain(rows: unknown[]) {
  const result: any = { then: (resolve: (rows: unknown[]) => void) => resolve(rows) };
  for (const method of ['from', 'where', 'limit', 'orderBy', 'values', 'set', 'returning', 'onConflictDoNothing']) {
    result[method] = vi.fn(() => result);
  }
  return result;
}

const row = { id: 'link-1', orgId: 'org-1', configPolicyId: 'policy-1', featureType: 'event_log' };
const auth = { scope: 'system', orgCondition: () => undefined } as unknown as AuthContext;

describe('configuration policy caller transaction', () => {
  it.each([
    ['create', (tx: any) => createConfigPolicy({ orgId: 'org-1' }, { name: 'Policy' }, 'user-1', tx)],
    ['update', (tx: any) => updateConfigPolicy('policy-1', { name: 'Changed' }, auth, tx)],
    ['add feature', (tx: any) => addFeatureLink('policy-1', 'event_log', null, {}, undefined, tx)],
    ['update feature', (tx: any) => updateFeatureLink('link-1', { inlineSettings: {} }, 'policy-1', undefined, tx)],
    ['list features and normalized settings', (tx: any) => listFeatureLinks('policy-1', tx)],
    ['assign', (tx: any) => assignPolicy('policy-1', 'organization', 'org-1', 0, 'user-1', undefined, undefined, tx)],
  ])('%s uses the supplied transaction exclusively', async (_name, invoke) => {
    vi.clearAllMocks();
    const tx: any = {
      select: vi.fn(() => chain([row])),
      insert: vi.fn(() => chain([row])),
      update: vi.fn(() => chain([row])),
      delete: vi.fn(() => chain([])),
      transaction: vi.fn((fn: (nested: unknown) => unknown) => fn(tx)),
    };
    await invoke(tx);
    for (const method of ['select', 'insert', 'update', 'delete', 'transaction'] as const) {
      expect(db[method]).not.toHaveBeenCalled();
    }
    expect(tx.select.mock.calls.length + tx.insert.mock.calls.length + tx.update.mock.calls.length).toBeGreaterThan(0);
    if (_name === 'list features and normalized settings') expect(tx.select).toHaveBeenCalledTimes(2);
  });
});
