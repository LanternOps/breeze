import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// #12305: the Create/Edit Ring dialog on /patches holds a long form. A stray
// click outside it, Escape, the X or Cancel used to throw the input away.
vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));

import PatchesPage from './PatchesPage';
import { fetchWithAuth } from '../../stores/auth';
import { useUiStore } from '../../stores/uiStore';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => {
  const read = () => ({ currentOrgId: null, organizations: [] });
  return { useOrgStore: Object.assign(read, { getState: read }) };
});
vi.mock('../../lib/authScope', () => {
  const claims = () => ({ scope: 'partner', partnerId: 'p1', orgId: null });
  return { getJwtClaims: claims, useJwtClaims: () => ({ status: 'resolved' as const, claims: claims() }) };
});
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const backdrop = () => document.querySelector('.dialog-backdrop') as HTMLElement;
const nameInput = () => screen.getByPlaceholderText('e.g. Pilot, Broad') as HTMLInputElement;
const ringDialog = () => screen.getAllByRole('dialog')[0];
const discardDialog = () => screen.queryByTestId('discard-ring-changes-dialog');

async function openNewRing() {
  render(<PatchesPage />);
  fireEvent.click(await screen.findByTestId('patch-new-ring'));
  await waitFor(() => expect(nameInput()).toBeInTheDocument());
}

async function openAndType() {
  await openNewRing();
  fireEvent.change(nameInput(), { target: { value: 'Pilot' } });
  await waitFor(() => expect(useUiStore.getState().dirtyFormCount).toBe(1));
}

describe('PatchesPage ring editor unsaved changes guard (#12305)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({ dirtyFormCount: 0 });
    window.history.replaceState({}, '', '/#rings');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/update-rings') return json({ data: [] });
      if (url.startsWith('/patches')) return json({ data: [] });
      return json({}, false, 404);
    });
  });

  it('closes an untouched form on a backdrop click, with no prompt', async () => {
    await openNewRing();

    fireEvent.click(backdrop());

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(discardDialog()).not.toBeInTheDocument();
  });

  it('ignores a backdrop click once the form has changes, and keeps what was typed', async () => {
    await openAndType();

    fireEvent.click(backdrop());

    expect(ringDialog()).toBeInTheDocument();
    expect(nameInput().value).toBe('Pilot');
    expect(discardDialog()).not.toBeInTheDocument();
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(ringDialog(), { key: 'Escape' })],
    ['the close button', () => fireEvent.click(within(ringDialog()).getByRole('button', { name: /^close$/i }))],
    ['Cancel', () => fireEvent.click(within(ringDialog()).getByRole('button', { name: /^cancel$/i }))],
  ])('asks before %s discards changes: keep editing keeps the form, discard closes it', async (_label, dismiss) => {
    await openAndType();

    dismiss();
    const confirm = (await screen.findByTestId('discard-ring-changes-dialog')).closest('[role="dialog"]') as HTMLElement;
    fireEvent.click(within(confirm).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(discardDialog()).not.toBeInTheDocument());
    expect(nameInput().value).toBe('Pilot');

    dismiss();
    fireEvent.click(await screen.findByTestId('discard-ring-changes-confirm'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('blocks keyboard shortcuts only while the edited form is open', async () => {
    await openAndType();
    expect(useUiStore.getState().dirtyFormCount).toBe(1);

    fireEvent.click(within(ringDialog()).getByRole('button', { name: /^cancel$/i }));
    fireEvent.click(await screen.findByTestId('discard-ring-changes-confirm'));

    await waitFor(() => expect(useUiStore.getState().dirtyFormCount).toBe(0));
  });
});
