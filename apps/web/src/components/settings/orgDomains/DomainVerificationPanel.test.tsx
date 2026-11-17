import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DomainVerificationPanel } from './DomainVerificationPanel';
import type { DomainMethodAvailability } from './methodAvailability';
import type { CustomerDomainView } from './types';
import { DOMAINS, ORG, callsTo, domainView, json, routeFetch, verifiedDns } from './testFixtures';

const fetchWithAuthMock = vi.fn();
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));
const navigateToMock = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateToMock(...a) }));
const showToastMock = vi.fn();
vi.mock('../../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

const ALL_AVAILABLE: DomainMethodAvailability = { entra_tenant: { available: true }, google_directory: { available: true } };

function renderPanel(domain: CustomerDomainView, availability: DomainMethodAvailability = ALL_AVAILABLE) {
  const onChanged = vi.fn();
  render(<DomainVerificationPanel orgId={ORG} domain={domain} availability={availability} onChanged={onChanged} />);
  return { onChanged };
}

const errorToasts = () => showToastMock.mock.calls.filter(([arg]) => (arg as { type?: string }).type === 'error');

describe('DomainVerificationPanel', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    showToastMock.mockReset();
    navigateToMock.mockReset();
  });

  it('DNS method shows record name/value and Check now posts verification/check with method dns_txt', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}/d1/verification/dns`]: () =>
        json({ data: { recordName: '_breeze-verify.contoso.com', recordValue: 'breeze-verification=tok' } }),
      [`POST ${DOMAINS}/d1/verification/check`]: () =>
        json({ data: { result: 'verified', method: 'dns_txt', displacedOrgId: null } }),
    });
    const { onChanged } = renderPanel(domainView());

    fireEvent.click(screen.getByTestId('domain-dns-start'));
    expect(await screen.findByTestId('domain-dns-record-name')).toHaveValue('_breeze-verify.contoso.com');
    expect(screen.getByTestId('domain-dns-record-value')).toHaveValue('breeze-verification=tok');

    fireEvent.click(screen.getByTestId('domain-verify-check'));
    await waitFor(() => expect(callsTo(fetchWithAuthMock, 'POST', `${DOMAINS}/d1/verification/check`)).toHaveLength(1));
    const [, init] = callsTo(fetchWithAuthMock, 'POST', `${DOMAINS}/d1/verification/check`)[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ method: 'dns_txt' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('shows an existing DNS record without starting a new one', async () => {
    renderPanel(domainView({
      state: 'pending_dns',
      dnsRecord: { recordName: '_breeze-verify.contoso.com', recordValue: 'breeze-verification=existing' },
    }));
    expect(screen.getByTestId('domain-dns-record-value')).toHaveValue('breeze-verification=existing');
    expect(screen.queryByTestId('domain-dns-start')).toBeNull();
    expect(screen.getByTestId('domain-verify-check')).toBeEnabled();
  });

  it('a failed check renders the reason inline and no error toast', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}/d1/verification/check`]: () => json({ data: { result: 'failed', reason: 'record_missing' } }),
    });
    const { onChanged } = renderPanel(domainView({ state: 'pending_dns', dnsRecord: { recordName: 'n', recordValue: 'v' } }));
    fireEvent.click(screen.getByTestId('domain-verify-check'));
    expect(await screen.findByTestId('domain-verify-result')).toHaveTextContent(/record was not found/i);
    expect(errorToasts()).toHaveLength(0);
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    // last checked moved, so the list refreshes.
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('google_scope_missing names the scope to add', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}/d1/verification/check`]: () => json({ data: { result: 'unavailable', reason: 'google_scope_missing' } }),
    });
    renderPanel(domainView());
    fireEvent.click(screen.getByTestId('domain-method-google_directory'));
    fireEvent.click(screen.getByTestId('domain-verify-check'));
    expect(await screen.findByTestId('domain-verify-result'))
      .toHaveTextContent('https://www.googleapis.com/auth/admin.directory.domain.readonly');
    expect(errorToasts()).toHaveLength(0);
  });

  it('a DOMAIN_VERIFIED_ELSEWHERE refusal renders inline, not as a toast', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}/d1/verification/check`]: () => json({ error: 'verified elsewhere', code: 'DOMAIN_VERIFIED_ELSEWHERE' }, 409),
    });
    renderPanel(domainView());
    fireEvent.click(screen.getByTestId('domain-method-entra_tenant'));
    fireEvent.click(screen.getByTestId('domain-verify-check'));
    expect(await screen.findByTestId('domain-verify-result')).toHaveTextContent(/verified for another organization/i);
    expect(errorToasts()).toHaveLength(0);
  });

  it('Microsoft is disabled with a link to #portal when the org has no proven tenant', () => {
    renderPanel(domainView(), { entra_tenant: { available: false, reason: 'tenant_not_proven' }, google_directory: { available: true } });
    expect(screen.getByTestId('domain-method-entra_tenant')).toBeDisabled();
    const why = screen.getByTestId('domain-method-unavailable-entra_tenant');
    expect(why).toHaveTextContent(/not proven/i);
    expect(why.querySelector('a')?.getAttribute('href')).toBe('#portal');
  });

  it('Microsoft without an M365 connection says to connect Microsoft 365 or use DNS', () => {
    renderPanel(domainView(), { entra_tenant: { available: false, reason: 'connection_missing' }, google_directory: { available: true } });
    expect(screen.getByTestId('domain-method-entra_tenant')).toBeDisabled();
    expect(screen.getByTestId('domain-method-unavailable-entra_tenant')).toHaveTextContent(/Microsoft 365 connection/i);
  });

  it('Google is disabled when the org has no Google Workspace connection', () => {
    renderPanel(domainView(), { entra_tenant: { available: true }, google_directory: { available: false, reason: 'connection_missing' } });
    expect(screen.getByTestId('domain-method-google_directory')).toBeDisabled();
    expect(screen.getByTestId('domain-method-unavailable-google_directory')).toHaveTextContent(/Google Workspace/i);
  });

  it('a verified domain locks the other methods and offers Remove verification', async () => {
    routeFetch(fetchWithAuthMock, {
      [`DELETE ${DOMAINS}/d1/verification`]: () => json({ data: { removed: true } }),
    });
    const { onChanged } = renderPanel(verifiedDns());
    expect(screen.getByTestId('domain-method-entra_tenant')).toBeDisabled();
    expect(screen.getByTestId('domain-method-google_directory')).toBeDisabled();
    expect(screen.getByTestId('domain-method-dns_txt')).toBeChecked();
    fireEvent.click(screen.getByTestId('domain-verify-remove'));
    fireEvent.click(await screen.findByTestId('domain-verify-remove-confirm'));
    await waitFor(() => expect(callsTo(fetchWithAuthMock, 'DELETE', `${DOMAINS}/d1/verification`)).toHaveLength(1));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('an inactive domain cannot be checked', () => {
    renderPanel(domainView({ isActive: false, state: 'pending_dns', dnsRecord: { recordName: 'n', recordValue: 'v' } }));
    expect(screen.getByTestId('domain-verify-check')).toBeDisabled();
    expect(screen.getByTestId('domain-verify-inactive')).toBeInTheDocument();
  });

  it('a failed DNS start toasts once, shows no record and does not refresh the list', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}/d1/verification/dns`]: () => json({ error: 'boom' }, 500),
    });
    const { onChanged } = renderPanel(domainView());
    fireEvent.click(screen.getByTestId('domain-dns-start'));
    await waitFor(() => expect(errorToasts()).toHaveLength(1));
    expect(screen.queryByTestId('domain-dns-record-value')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Remove verification sends nothing until confirmed; a failed DELETE keeps the dialog and the row', async () => {
    routeFetch(fetchWithAuthMock, {
      [`DELETE ${DOMAINS}/d1/verification`]: () => json({ error: 'conflict', code: 'SOMETHING_ELSE' }, 409),
    });
    const { onChanged } = renderPanel(verifiedDns());
    fireEvent.click(screen.getByTestId('domain-verify-remove'));
    await screen.findByTestId('domain-verify-remove-confirm');
    expect(callsTo(fetchWithAuthMock, 'DELETE', `${DOMAINS}/d1/verification`)).toHaveLength(0);
    fireEvent.click(screen.getByTestId('domain-verify-remove-confirm'));
    await waitFor(() => expect(errorToasts()).toHaveLength(1));
    expect(screen.getByTestId('domain-verify-remove-confirm')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Check now on a verified row renders a failed re-check inline and refreshes the list', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}/d1/verification/check`]: () => json({ data: { result: 'failed', reason: 'record_missing' } }),
    });
    const { onChanged } = renderPanel(verifiedDns());
    expect(screen.getByTestId('domain-verify-check')).toHaveTextContent(/check now/i);
    fireEvent.click(screen.getByTestId('domain-verify-check'));
    expect(await screen.findByTestId('domain-verify-result')).toHaveTextContent(/record was not found/i);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(errorToasts()).toHaveLength(0);
  });

  it('a 401 on the check goes to login without a toast', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}/d1/verification/check`]: () => json({ error: 'unauthorized' }, 401),
    });
    renderPanel(domainView({ state: 'pending_dns', dnsRecord: { recordName: 'n', recordValue: 'v' } }));
    fireEvent.click(screen.getByTestId('domain-verify-check'));
    await waitFor(() => expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true }));
    expect(showToastMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('domain-verify-result')).toBeNull();
  });

  it('a refusal that means the row changed elsewhere (CUSTOMER_DOMAIN_NOT_FOUND) also refreshes the list', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}/d1/verification/check`]: () => json({ error: 'gone', code: 'CUSTOMER_DOMAIN_NOT_FOUND' }, 404),
    });
    const { onChanged } = renderPanel(domainView({ state: 'pending_dns', dnsRecord: { recordName: 'n', recordValue: 'v' } }));
    fireEvent.click(screen.getByTestId('domain-verify-check'));
    expect(await screen.findByTestId('domain-verify-result')).toHaveTextContent(/no longer in this organization/i);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('an unknown check result is shown as an unfinished check and still refreshes the list', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}/d1/verification/check`]: () => json({ data: { result: 'queued' } }),
    });
    const { onChanged } = renderPanel(domainView({ state: 'pending_dns', dnsRecord: { recordName: 'n', recordValue: 'v' } }));
    fireEvent.click(screen.getByTestId('domain-verify-check'));
    expect(await screen.findByTestId('domain-verify-result')).toHaveTextContent(/could not finish.*did not pass/i);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(errorToasts()).toHaveLength(0);
  });

  it('a reason that names an Object prototype key falls back to the generic label', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}/d1/verification/check`]: () => json({ data: { result: 'failed', reason: 'constructor' } }),
    });
    renderPanel(domainView({ state: 'pending_dns', dnsRecord: { recordName: 'n', recordValue: 'v' } }));
    fireEvent.click(screen.getByTestId('domain-verify-check'));
    expect(await screen.findByTestId('domain-verify-result')).toHaveTextContent('Not verified. The check did not pass.');
  });
});
