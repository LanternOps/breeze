import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '@/lib/api/callerVerification';
import { useAuthStore } from '@/stores/auth';
import { ActionError } from '@/lib/runAction';
import { ContactVerificationDrawer } from './ContactVerificationDrawer';
import { ORG, CONTACT, TARGET, USER, row, history } from './testFixtures';

vi.mock('@/lib/api/callerVerification', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/callerVerification')>()),
  contactHistory: vi.fn(), fenceOverride: vi.fn(), directoryUsers: vi.fn(), bindContact: vi.fn(),
  unbindContact: vi.fn(), attestDestination: vi.fn(), syncDirectory: vi.fn(),
}));
vi.mock('./VerifyCallerModal', () => ({
  VerifyCallerModal: (p: { orgId: string; initialContactId?: string; lockContact?: boolean }) =>
    <div data-testid="cv-modal" data-contact={p.initialContactId} data-locked={String(!!p.lockContact)} />,
}));

const binding: api.BindingView = {
  id: TARGET, entraTenantId: ORG, entraOid: CONTACT, upnSnapshot: 'ada@example.test', osPrincipal: null, osUsername: null,
  source: 'technician_attested', establishedAt: '2026-09-01T00:00:00Z', attestedAt: '2026-09-01T00:00:00Z', revokedAt: null,
};
const destination: api.DestinationView = {
  id: row.id, kind: 'mobile', valueRedacted: '+1 •••• 12', setAt: '2026-09-01T00:00:00Z', source: 'import', attestedAt: null, established: false,
};

beforeEach(() => {
  useAuthStore.setState({ user: { id: USER, email: 't@example.test', name: 'Tech' } as never });
  vi.mocked(api.contactHistory).mockResolvedValue({ ...history, rows: [{ ...row, status: 'verified' }], bindings: [binding], destinations: [destination] });
  vi.mocked(api.fenceOverride).mockResolvedValue({ ok: true });
  vi.mocked(api.unbindContact).mockResolvedValue({ ok: true });
  vi.mocked(api.attestDestination).mockResolvedValue({ id: row.id, attestedAt: '2026-09-02T00:00:00Z' });
  vi.mocked(api.bindContact).mockResolvedValue({});
  vi.mocked(api.syncDirectory).mockResolvedValue({ imported: 1, revoked: 0, complete: true });
});
afterEach(() => vi.clearAllMocks());

const open = () => render(<ContactVerificationDrawer orgId={ORG} contactId={CONTACT} contactName="Ada" onClose={vi.fn()} />);

it('shows history with ownership, bindings and destinations', async () => {
  open();
  const historyList = await screen.findByTestId('cv-history');
  expect(within(historyList).getByText('Verified')).toBeVisible();
  expect(within(historyList).getByText(/by you/)).toBeVisible();
  expect(screen.getByText('ada@example.test')).toBeVisible();
  expect(screen.getByText('Linked by technician')).toBeVisible();
  expect(screen.getByText('+1 •••• 12')).toBeVisible();
  expect(screen.getByText('Not yet trusted')).toBeVisible();
  expect(api.contactHistory).toHaveBeenCalledWith(ORG, CONTACT, expect.any(AbortSignal));
});

it('starts a verification for this contact with the requester locked', async () => {
  open();
  fireEvent.click(await screen.findByTestId('cv-drawer-verify'));
  expect(screen.getByTestId('cv-modal')).toHaveAttribute('data-contact', CONTACT);
  expect(screen.getByTestId('cv-modal')).toHaveAttribute('data-locked', 'true');
});

it('lifts a fence only with a 20-character reason, then reloads', async () => {
  vi.mocked(api.contactHistory).mockResolvedValue({ ...history, fencedUntil: '2026-09-20T12:00:00Z' });
  open();
  fireEvent.click(await screen.findByTestId('cv-fence-open'));
  const reason = screen.getByTestId('cv-fence-reason');
  fireEvent.change(reason, { target: { value: 'short' } });
  expect(screen.getByTestId('cv-fence-submit')).toBeDisabled();
  fireEvent.change(reason, { target: { value: 'Met the contact in person and confirmed identity' } });
  await act(async () => { fireEvent.click(screen.getByTestId('cv-fence-submit')); });
  expect(api.fenceOverride).toHaveBeenCalledWith(ORG, CONTACT, 'Met the contact in person and confirmed identity');
  expect(api.contactHistory).toHaveBeenCalledTimes(2);
});

it('confirms a destination and unlinks a binding through the shipped routes', async () => {
  open();
  const attest = await screen.findByTestId(`cv-destination-attest-${row.id}`);
  await act(async () => { fireEvent.click(attest); });
  expect(api.attestDestination).toHaveBeenCalledWith(ORG, CONTACT, row.id);
  await act(async () => { fireEvent.click(screen.getByTestId(`cv-unbind-${TARGET}`)); });
  expect(api.unbindContact).toHaveBeenCalledWith(ORG, CONTACT, TARGET);
});

it('links only a directory-returned account', async () => {
  const user = { entraTenantId: ORG, entraOid: TARGET, upn: 'grace@example.test', displayName: 'Grace' };
  vi.mocked(api.directoryUsers).mockResolvedValue({ available: true, users: [user], truncated: false });
  open();
  fireEvent.click(await screen.findByTestId('cv-link-open'));
  fireEvent.change(screen.getByTestId('cv-directory-search'), { target: { value: 'gra' } });
  await act(async () => { fireEvent.click(screen.getByTestId('cv-directory-submit')); });
  expect(api.directoryUsers).toHaveBeenCalledWith(ORG, 'gra', expect.any(AbortSignal));
  await act(async () => { fireEvent.click(screen.getByTestId(`cv-directory-link-${TARGET}`)); });
  expect(api.bindContact).toHaveBeenCalledWith(ORG, CONTACT, user);
});

it('explains an unavailable directory instead of offering stale candidates', async () => {
  vi.mocked(api.directoryUsers).mockResolvedValue({ available: false, users: [], truncated: false });
  open();
  fireEvent.click(await screen.findByTestId('cv-link-open'));
  fireEvent.change(screen.getByTestId('cv-directory-search'), { target: { value: 'gra' } });
  await act(async () => { fireEvent.click(screen.getByTestId('cv-directory-submit')); });
  expect(screen.getByText('The directory is not available for this organization.')).toBeVisible();
});

it('distinguishes a failed directory search from an unavailable directory', async () => {
  vi.mocked(api.directoryUsers).mockRejectedValueOnce(new ActionError('boom', 502)).mockRejectedValueOnce(new ActionError('nope', 404));
  open();
  fireEvent.click(await screen.findByTestId('cv-link-open'));
  fireEvent.change(screen.getByTestId('cv-directory-search'), { target: { value: 'gra' } });
  await act(async () => { fireEvent.click(screen.getByTestId('cv-directory-submit')); });
  expect(screen.getByText('Directory search failed. Try again.')).toBeVisible();
  expect(screen.queryByText('The directory is not available for this organization.')).toBeNull();
  await act(async () => { fireEvent.click(screen.getByTestId('cv-directory-submit')); });
  expect(screen.getByText('The directory is not available for this organization.')).toBeVisible();
});

it('hides stale details when a reload fails after a mutation', async () => {
  open();
  const unbind = await screen.findByTestId(`cv-unbind-${TARGET}`);
  vi.mocked(api.contactHistory).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { fireEvent.click(unbind); });
  expect(await screen.findByText('Could not load verification details.')).toBeVisible();
  expect(screen.queryByTestId(`cv-unbind-${TARGET}`)).toBeNull();
  expect(screen.queryByTestId('cv-history')).toBeNull();
});

it('syncs this contact\'s active directory links', async () => {
  open();
  const sync = await screen.findByTestId('cv-sync');
  await act(async () => { fireEvent.click(sync); });
  expect(api.syncDirectory).toHaveBeenCalledWith(ORG, [{ contactId: CONTACT, entraOid: CONTACT }]);
});

it('shows a load failure with retry', async () => {
  vi.mocked(api.contactHistory).mockRejectedValueOnce(new Error('boom'));
  open();
  fireEvent.click(await screen.findByText('Try again'));
  await waitFor(() => expect(api.contactHistory).toHaveBeenCalledTimes(2));
});
