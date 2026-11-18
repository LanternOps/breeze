import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { YARA_BUILTIN_RULE_SET_ID } from '@breeze/shared';

const { fetchWithAuth, showToast, ownerScope } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  showToast: vi.fn(),
  ownerScope: { isPartnerScope: false, defaultOwnerScope: 'organization' as 'organization' | 'partner' },
}));

vi.mock('@/stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/auth')>()),
  fetchWithAuth,
}));
vi.mock('../../shared/Toast', () => ({ showToast }));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({ useDefaultOwnerScope: () => ownerScope }));

import DetectionRulesPage from './DetectionRulesPage';

const json = (status: number, payload: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }) as unknown as Response;

function summary(over: Record<string, unknown>) {
  return {
    id: 'set-1',
    orgId: 'org-a',
    partnerId: null,
    name: 'Org set',
    description: null,
    source: 'custom',
    isBuiltin: false,
    enabled: true,
    autoQuarantine: false,
    currentVersion: 2,
    publishedVersion: 2,
    publishedSha256: 'a'.repeat(64),
    publishedAt: '2026-10-20T00:00:00.000Z',
    publishedEngine: 'yara-x',
    stale: false,
    ruleCount: 3,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...over,
  };
}

const SETS = [
  summary({ id: YARA_BUILTIN_RULE_SET_ID, orgId: null, isBuiltin: true, name: 'Breeze built-in', source: 'builtin' }),
  summary({ id: 'set-partner', orgId: null, partnerId: 'p-1', name: 'MSP wide' }),
  summary({ id: 'set-stale', name: 'Broken', stale: true }),
  summary({ id: 'set-new', name: 'Fresh', publishedVersion: 0, currentVersion: 0, ruleCount: 0 }),
  summary({ id: 'set-off', name: 'Off', enabled: false }),
];

function routeFetch(listResponse: Response = json(200, { data: SETS })) {
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/security/yara/rule-sets' && (!init?.method || init.method === 'GET')) return listResponse;
    const m = url.match(/^\/security\/yara\/rule-sets\/([^/?]+)$/);
    if (m && (!init?.method || init.method === 'GET')) {
      const set = SETS.find((s) => s.id === m[1]) ?? SETS[2];
      return json(200, { data: { ...set, rules: [] } });
    }
    if (url === '/security/yara/rule-sets' && init?.method === 'POST') {
      return json(201, { data: summary({ id: 'set-created', name: 'Created' }) });
    }
    return json(404, { error: 'not found' });
  });
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('DetectionRulesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ownerScope.isPartnerScope = false;
    ownerScope.defaultOwnerScope = 'organization';
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('renders one row per rule set with owner and status badges', async () => {
    routeFetch();
    render(<DetectionRulesPage />);
    await settle();

    expect(screen.getByTestId(`rule-set-row-${YARA_BUILTIN_RULE_SET_ID}`)).toBeInTheDocument();
    expect(
      screen.getByTestId(`rule-set-row-${YARA_BUILTIN_RULE_SET_ID}`).querySelector('[data-testid="rule-set-badge-builtin"]'),
    ).not.toBeNull();
    expect(
      screen.getByTestId('rule-set-row-set-partner').querySelector('[data-testid="rule-set-badge-all-orgs"]'),
    ).not.toBeNull();
    expect(
      screen.getByTestId('rule-set-row-set-stale').querySelector('[data-testid="rule-set-badge-errors"]'),
    ).not.toBeNull();
    expect(
      screen.getByTestId('rule-set-row-set-new').querySelector('[data-testid="rule-set-badge-unpublished"]'),
    ).not.toBeNull();
    expect(
      screen.getByTestId('rule-set-row-set-off').querySelector('[data-testid="rule-set-badge-disabled"]'),
    ).not.toBeNull();
    // A healthy org set carries none of the status badges.
    const healthy = screen.getByTestId('rule-set-row-set-partner');
    expect(healthy.querySelector('[data-testid="rule-set-badge-errors"]')).toBeNull();
    expect(healthy.querySelector('[data-testid="rule-set-badge-unpublished"]')).toBeNull();
    expect(healthy.querySelector('[data-testid="rule-set-badge-disabled"]')).toBeNull();
  });

  it('clicking a row selects the set in the hash', async () => {
    routeFetch();
    render(<DetectionRulesPage />);
    await settle();

    fireEvent.click(screen.getByTestId('rule-set-row-set-stale'));
    expect(window.location.hash).toBe('#set-stale');
    await settle();
    expect(screen.getByTestId('rule-set-editor')).toBeInTheDocument();
  });

  it('loading with #<id> opens that set', async () => {
    window.location.hash = '#set-partner';
    routeFetch();
    render(<DetectionRulesPage />);
    await settle();

    expect(screen.getByTestId('rule-set-editor')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith('/security/yara/rule-sets/set-partner');
  });

  it('a 403 list renders AccessDenied with no retry', async () => {
    routeFetch(json(403, { error: 'Forbidden' }));
    render(<DetectionRulesPage />);
    await settle();

    expect(screen.getByTestId('detection-rules-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('detection-rules-retry')).toBeNull();
  });

  it('a 500 list is retryable, not a permission state', async () => {
    routeFetch(json(500, { error: 'boom' }));
    render(<DetectionRulesPage />);
    await settle();

    expect(screen.queryByTestId('detection-rules-denied')).toBeNull();
    expect(screen.getByTestId('detection-rules-retry')).toBeInTheDocument();
  });

  it('an org-scope user gets no "All orgs" owner option', async () => {
    routeFetch();
    render(<DetectionRulesPage />);
    await settle();

    fireEvent.click(screen.getByTestId('rule-set-new'));
    expect(screen.getByTestId('rule-set-create-form')).toBeInTheDocument();
    expect(screen.queryByTestId('rule-set-create-owner-partner')).toBeNull();
  });

  it('a partner-scope user can create an "All orgs" set', async () => {
    ownerScope.isPartnerScope = true;
    ownerScope.defaultOwnerScope = 'partner';
    routeFetch();
    render(<DetectionRulesPage />);
    await settle();

    fireEvent.click(screen.getByTestId('rule-set-new'));
    expect(screen.getByTestId('rule-set-create-owner-partner')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('rule-set-create-name'), { target: { value: 'Advisory 42' } });
    fireEvent.click(screen.getByTestId('rule-set-create-owner-partner'));
    fireEvent.click(screen.getByTestId('rule-set-create-submit'));
    await settle();

    const post = fetchWithAuth.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(post).toBeDefined();
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ name: 'Advisory 42', ownerScope: 'partner' });
    await waitFor(() => expect(window.location.hash).toBe('#set-created'));
  });
});
