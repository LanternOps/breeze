import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import enSettings from '../../locales/en/settings.json';

// Resolve keys against the real en strings so the tooltip assertions are meaningful.
function translate(key: string, opts?: Record<string, unknown>): string {
  const value = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    enSettings as unknown
  );
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(opts?.[k] ?? ''));
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth, handleSessionExpired: vi.fn() }));

import AccessReviewPage, { decisionErrorMessage } from './AccessReviewPage';
import enErrors from '../../locales/en/errors.json';

const REVIEW_ID = 'rev-1';
const OWN = { id: 'item-own', userId: 'u-me', userName: 'Me Admin', userEmail: 'me@example.test' };
const OTHER = { id: 'item-other', userId: 'u-other', userName: 'Other Person', userEmail: 'other@example.test' };

function item(base: typeof OWN, extra: Record<string, unknown> = {}) {
  return {
    ...base,
    roleId: 'r1',
    roleName: 'Admin',
    decision: 'pending',
    permissions: [],
    lastActiveAt: null,
    ...extra
  };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function setupFetch(detail: { selfDecision: 'blocked' | 'single_admin_exception' | null; items: unknown[] }) {
  fetchWithAuth.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/access-reviews') {
      return ok({
        data: [{ id: REVIEW_ID, name: 'Q4 Review', status: 'in_progress', createdAt: '2026-10-01T00:00:00Z' }]
      });
    }
    if (url === '/users') return ok({ users: [] });
    if (url === `/access-reviews/${REVIEW_ID}` && (!init || !init.method || init.method === 'GET')) {
      return ok({
        id: REVIEW_ID,
        name: 'Q4 Review',
        status: 'in_progress',
        createdAt: '2026-10-01T00:00:00Z',
        viewer: { userId: 'u-me', selfDecision: detail.selfDecision },
        items: detail.items
      });
    }
    if (init?.method === 'PATCH') return ok({});
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function openReview() {
  render(<AccessReviewPage />);
  const reviewButton = await screen.findByRole('button', { name: 'Review' });
  fireEvent.click(reviewButton);
  await screen.findByText('other@example.test');
}

function rowFor(email: string): HTMLElement {
  const row = screen.getByText(email).closest('tr');
  if (!row) throw new Error(`no row for ${email}`);
  return row as HTMLElement;
}

function patchCalls(): string[] {
  return fetchWithAuth.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([url]) => url as string);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AccessReviewPage separation of duties', () => {
  it('blocked: own item has no decision buttons, shows tooltip + disabled checkbox; others keep buttons', async () => {
    setupFetch({ selfDecision: 'blocked', items: [item(OWN), item(OTHER)] });
    await openReview();

    const ownRow = rowFor(OWN.userEmail);
    expect(within(ownRow).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(ownRow).queryByRole('button', { name: 'Revoke' })).toBeNull();

    const blocked = screen.getByTestId(`access-review-own-item-blocked-${OWN.id}`);
    expect(blocked.getAttribute('title')).toBeTruthy();
    expect(blocked.getAttribute('title')).toBe(enSettings.accessReviewPage.ownItemBlocked);

    expect((within(ownRow).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);

    const otherRow = rowFor(OTHER.userEmail);
    expect(within(otherRow).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(otherRow).getByRole('button', { name: 'Revoke' })).toBeTruthy();
    expect(screen.queryByTestId(`access-review-own-item-blocked-${OTHER.id}`)).toBeNull();
  });

  it('single_admin_exception: own item keeps Approve/Revoke and shows the warning', async () => {
    setupFetch({ selfDecision: 'single_admin_exception', items: [item(OWN), item(OTHER)] });
    await openReview();

    const ownRow = rowFor(OWN.userEmail);
    expect(within(ownRow).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(ownRow).getByRole('button', { name: 'Revoke' })).toBeTruthy();
    expect(screen.getByTestId(`access-review-self-decision-warning-${OWN.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`access-review-own-item-blocked-${OWN.id}`)).toBeNull();
    expect(screen.queryByTestId(`access-review-self-decision-warning-${OTHER.id}`)).toBeNull();
  });

  it('renders the self-decided badge only for items with selfDecided: true', async () => {
    setupFetch({
      selfDecision: null,
      items: [item(OWN, { decision: 'approved', selfDecided: true }), item(OTHER, { selfDecided: false })]
    });
    await openReview();

    expect(screen.getByTestId(`access-review-self-decided-${OWN.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`access-review-self-decided-${OTHER.id}`)).toBeNull();
  });

  it('bulk approve after select-all never PATCHes the blocked own item', async () => {
    setupFetch({ selfDecision: 'blocked', items: [item(OWN), item(OTHER)] });
    await openReview();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect((within(rowFor(OTHER.userEmail)).getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect((within(rowFor(OWN.userEmail)).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));

    await waitFor(() => expect(patchCalls()).toHaveLength(1));
    expect(patchCalls()).toEqual([`/access-reviews/${REVIEW_ID}/items/${OTHER.id}`]);
    expect(patchCalls().some((u) => u.includes(OWN.id))).toBe(false);
  });
});

describe('decisionErrorMessage', () => {
  const res = (body: unknown, json = true) =>
    ({ json: async () => { if (!json) throw new SyntaxError('not json'); return body; } }) as unknown as Response;

  it('prefers the localized string for a known error code over the API prose', async () => {
    const msg = await decisionErrorMessage(
      res({ error: 'server prose', code: 'ACCESS_REVIEW_SELF_DECISION' }),
      'fallback'
    );
    expect(msg).toBe(enErrors.ACCESS_REVIEW_SELF_DECISION);
  });

  it('uses the API prose when there is no known code', async () => {
    expect(await decisionErrorMessage(res({ error: 'Cannot modify completed review' }), 'fallback')).toBe(
      'Cannot modify completed review'
    );
    expect(await decisionErrorMessage(res({ error: 'x', code: 'NOT_A_REAL_CODE' }), 'fallback')).toBe('x');
  });

  it('falls back on a non-JSON body or an empty / non-string error', async () => {
    expect(await decisionErrorMessage(res(null, false), 'fallback')).toBe('fallback');
    expect(await decisionErrorMessage(res({ error: '' }), 'fallback')).toBe('fallback');
    expect(await decisionErrorMessage(res({ error: 42 }), 'fallback')).toBe('fallback');
  });
});
