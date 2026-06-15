import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbSelectMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: { select: dbSelectMock },
}));

import {
  defaultClientAiPolicy,
  getOrgPolicy,
  isClientUserPermitted,
  requireClientAiEnabled,
} from './clientAiPolicy';

const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const USER_A = 'aaaaaaaa-1111-4222-8333-444455556666';
const USER_B = 'bbbbbbbb-1111-4222-8333-444455556666';

function mockPolicyRow(row: object | undefined) {
  dbSelectMock.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(row ? [row] : [])),
      })),
    })),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('defaultClientAiPolicy', () => {
  it('is disabled with anthropic-only providers and sane limits', () => {
    const policy = defaultClientAiPolicy(ORG_ID);
    expect(policy).toMatchObject({
      orgId: ORG_ID,
      enabled: false,
      userAccess: 'all',
      selectedUserIds: [],
      allowedProviders: ['anthropic'],
      allowedModels: [],
      writeMode: 'readwrite',
      writeApproval: 'ask',
      dlpConfig: {},
      dailyBudgetCents: null,
      monthlyBudgetCents: null,
      perUserMessagesPerMinute: 10,
      orgMessagesPerHour: 500,
      retentionDays: null,
      branding: {},
    });
  });
});

describe('getOrgPolicy', () => {
  it('returns the disabled default when no row exists', async () => {
    mockPolicyRow(undefined);
    const policy = await getOrgPolicy(ORG_ID);
    expect(policy.enabled).toBe(false);
    expect(policy.orgId).toBe(ORG_ID);
  });

  it('normalizes a stored row (jsonb columns coerced defensively)', async () => {
    mockPolicyRow({
      orgId: ORG_ID,
      enabled: true,
      userAccess: 'selected',
      selectedUserIds: [USER_A],
      allowedProviders: ['anthropic'],
      allowedModels: ['claude-sonnet-4-5-20250929'],
      writeMode: 'readonly',
      writeApproval: 'allow_auto',
      dlpConfig: { creditCards: 'redact' },
      dailyBudgetCents: 500,
      monthlyBudgetCents: 10000,
      perUserMessagesPerMinute: 5,
      orgMessagesPerHour: 100,
      retentionDays: 90,
      branding: { displayName: 'Acme IT' },
    });

    const policy = await getOrgPolicy(ORG_ID);
    expect(policy.enabled).toBe(true);
    expect(policy.userAccess).toBe('selected');
    expect(policy.selectedUserIds).toEqual([USER_A]);
    expect(policy.writeMode).toBe('readonly');
    expect(policy.writeApproval).toBe('allow_auto');
    expect(policy.dailyBudgetCents).toBe(500);
    expect(policy.retentionDays).toBe(90);
    expect(policy.branding).toEqual({ displayName: 'Acme IT' });
  });

  it('falls back to safe values when jsonb columns hold non-array garbage', async () => {
    mockPolicyRow({
      orgId: ORG_ID,
      enabled: true,
      userAccess: 'all',
      selectedUserIds: 'not-an-array',
      allowedProviders: null,
      allowedModels: 42,
      writeMode: 'readwrite',
      dlpConfig: null,
      dailyBudgetCents: null,
      monthlyBudgetCents: null,
      perUserMessagesPerMinute: 10,
      orgMessagesPerHour: 500,
      retentionDays: null,
      branding: null,
    });

    const policy = await getOrgPolicy(ORG_ID);
    expect(policy.selectedUserIds).toEqual([]);
    expect(policy.allowedProviders).toEqual(['anthropic']);
    expect(policy.allowedModels).toEqual([]);
    expect(policy.dlpConfig).toEqual({});
    expect(policy.branding).toEqual({});
  });

  it('default-denies writeApproval: any non-allow_auto value normalizes to ask', async () => {
    mockPolicyRow({
      ...defaultClientAiPolicy(ORG_ID),
      enabled: true,
      // garbage / unknown / legacy-null value must NOT enable auto-apply
      writeApproval: 'something_else',
    });
    const policy = await getOrgPolicy(ORG_ID);
    expect(policy.writeApproval).toBe('ask');
  });
});

describe('isClientUserPermitted', () => {
  it('permits everyone under userAccess=all', () => {
    const policy = { ...defaultClientAiPolicy(ORG_ID), enabled: true };
    expect(isClientUserPermitted(policy, USER_A)).toBe(true);
  });

  it('enforces the selected list under userAccess=selected', () => {
    const policy = {
      ...defaultClientAiPolicy(ORG_ID),
      enabled: true,
      userAccess: 'selected' as const,
      selectedUserIds: [USER_A],
    };
    expect(isClientUserPermitted(policy, USER_A)).toBe(true);
    expect(isClientUserPermitted(policy, USER_B)).toBe(false);
  });
});

describe('requireClientAiEnabled', () => {
  it('returns the policy when enabled', async () => {
    mockPolicyRow({ ...defaultClientAiPolicy(ORG_ID), enabled: true });
    const policy = await requireClientAiEnabled(ORG_ID);
    expect(policy?.enabled).toBe(true);
  });

  it('returns null when disabled or absent', async () => {
    mockPolicyRow(undefined);
    expect(await requireClientAiEnabled(ORG_ID)).toBeNull();
  });
});
