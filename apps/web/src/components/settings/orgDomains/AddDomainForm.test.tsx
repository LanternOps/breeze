import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AddDomainForm } from './AddDomainForm';
import { DOMAINS, ORG, callsTo, domainView, json, routeFetch } from './testFixtures';

const fetchWithAuthMock = vi.fn();
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToastMock = vi.fn();
vi.mock('../../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

describe('AddDomainForm', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    showToastMock.mockReset();
  });

  it('POSTs the trimmed domain and autoCreateContact, never an orgId', async () => {
    routeFetch(fetchWithAuthMock, { [`POST ${DOMAINS}`]: () => json({ data: domainView() }, 201) });
    const onAdded = vi.fn();
    render(<AddDomainForm orgId={ORG} onAdded={onAdded} />);
    expect(screen.getByTestId('org-domains-add-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('org-domains-add-input'), { target: { value: '  contoso.com ' } });
    fireEvent.click(screen.getByTestId('org-domains-add-auto-create'));
    fireEvent.click(screen.getByTestId('org-domains-add-submit'));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    const [, init] = callsTo(fetchWithAuthMock, 'POST', DOMAINS)[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ domain: 'contoso.com', autoCreateContact: false });
    expect(screen.getByTestId('org-domains-add-input')).toHaveValue('');
  });

  it('toasts the domain as the server stored it, not as typed', async () => {
    routeFetch(fetchWithAuthMock, { [`POST ${DOMAINS}`]: () => json({ data: domainView({ domain: 'contoso.com' }) }, 201) });
    render(<AddDomainForm orgId={ORG} onAdded={vi.fn()} />);
    fireEvent.change(screen.getByTestId('org-domains-add-input'), { target: { value: 'Contoso.COM' } });
    fireEvent.click(screen.getByTestId('org-domains-add-submit'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    expect(showToastMock).toHaveBeenCalledWith({ type: 'success', message: 'contoso.com added' });
  });

  it('a DOMAIN_ALREADY_MAPPED refusal keeps the input and toasts the friendly message', async () => {
    routeFetch(fetchWithAuthMock, {
      [`POST ${DOMAINS}`]: () => json({ error: 'Domain already mapped', code: 'DOMAIN_ALREADY_MAPPED' }, 409),
    });
    const onAdded = vi.fn();
    render(<AddDomainForm orgId={ORG} onAdded={onAdded} />);
    fireEvent.change(screen.getByTestId('org-domains-add-input'), { target: { value: 'contoso.com' } });
    fireEvent.click(screen.getByTestId('org-domains-add-submit'));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringMatching(/already added/i),
    })));
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.getByTestId('org-domains-add-input')).toHaveValue('contoso.com');
  });
});
