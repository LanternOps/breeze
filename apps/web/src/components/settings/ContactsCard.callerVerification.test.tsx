import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ContactsCard from './ContactsCard';

const fetchWithAuthMock = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const enabled = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => enabled.value }));
vi.mock('../callerVerification/ContactVerificationDrawer', () => ({
  ContactVerificationDrawer: (p: { orgId: string; contactId: string; onClose: () => void }) => (
    <div data-testid="cv-drawer-stub" data-org={p.orgId} data-contact={p.contactId}><button onClick={p.onClose}>close-drawer</button></div>
  ),
}));

const ORG = '11111111-1111-4111-8111-111111111111';
const ADA = '22222222-2222-4222-8222-222222222222';
const contact = { id: ADA, orgId: ORG, siteId: null, name: 'Ada', email: 'ada@acme.test', phone: null, mobile: null, title: null,
  roles: [], isPrimary: false, notes: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

beforeEach(() => {
  window.location.hash = 'contacts';
  fetchWithAuthMock.mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.includes('/contacts') ? { data: [contact], pagination: { page: 1, limit: 25, total: 1 } } : { data: [] },
  ), { status: 200 })));
});
afterEach(() => { vi.clearAllMocks(); enabled.value = true; window.location.hash = ''; });

it('opens the verification drawer for a row via the hash and closes back to the tab', async () => {
  render(<ContactsCard orgId={ORG} />);
  fireEvent.click(await screen.findByTestId(`org-contacts-verify-${ADA}`));
  expect(window.location.hash).toBe(`#contacts/${ADA}/verification`);
  const drawer = await screen.findByTestId('cv-drawer-stub');
  expect(drawer).toHaveAttribute('data-contact', ADA);
  expect(drawer).toHaveAttribute('data-org', ORG);
  await act(async () => { fireEvent.click(screen.getByText('close-drawer')); });
  expect(window.location.hash).toBe('#contacts');
  expect(screen.queryByTestId('cv-drawer-stub')).toBeNull();
});

it('opens from a deep link', async () => {
  window.location.hash = `contacts/${ADA}/verification`;
  render(<ContactsCard orgId={ORG} />);
  expect(await screen.findByTestId('cv-drawer-stub')).toHaveAttribute('data-contact', ADA);
});

it('shows no verification control and ignores a forged hash while disabled', async () => {
  enabled.value = false;
  window.location.hash = `contacts/${ADA}/verification`;
  render(<ContactsCard orgId={ORG} />);
  await screen.findByTestId(`org-contacts-row-${ADA}`);
  expect(screen.queryByTestId(`org-contacts-verify-${ADA}`)).toBeNull();
  expect(screen.queryByTestId('cv-drawer-stub')).toBeNull();
});
