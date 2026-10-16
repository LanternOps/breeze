import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import RecordApprovalDialog from './RecordApprovalDialog';

const request = {
  id: 'req-1',
  revision: 3,
  trigger: 'budget' as const,
  requestedExtensionMinutes: 60,
  requestedExtensionAmount: null,
  currencyCode: null,
};

const ok = (body: unknown = { data: {} }) => ({ ok: true, status: 200, json: async () => body }) as Response;
const fail = (status: number, body: unknown) => ({ ok: false, status, json: async () => body }) as Response;

function fill(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
  fetchWithAuth.mockResolvedValue(ok());
});

describe('RecordApprovalDialog', () => {
  it('blocks submit without a reference (blank or whitespace) and sends nothing', async () => {
    render(<RecordApprovalDialog open request={request} onClose={vi.fn()} onRecorded={vi.fn()} />);
    fill('record-approval-signer-name', 'Pat Customer');
    const submit = screen.getByTestId('record-approval-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fill('record-approval-reference', '   ');
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('blocks submit without a signer name', () => {
    render(<RecordApprovalDialog open request={request} onClose={vi.fn()} onRecorded={vi.fn()} />);
    fill('record-approval-reference', 'call 2026-10-12');
    expect((screen.getByTestId('record-approval-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('POSTs the shown revision and only the allowed fields (no actor/user keys)', async () => {
    const onRecorded = vi.fn();
    render(<RecordApprovalDialog open request={request} onClose={vi.fn()} onRecorded={onRecorded} />);
    fill('record-approval-reference', ' call 2026-10-12 ');
    fill('record-approval-signer-name', ' Pat Customer ');
    fill('record-approval-method', 'email');
    fireEvent.click(screen.getByTestId('record-approval-decision-denied'));
    fireEvent.click(screen.getByTestId('record-approval-submit'));
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    const [url, init] = fetchWithAuth.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/ticket-approval-requests/req-1/decide-on-behalf');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      decision: 'denied',
      revision: 3,
      method: 'email',
      reference: 'call 2026-10-12',
      signerName: 'Pat Customer',
    });
  });

  it('includes optional signer email and note when given', async () => {
    render(<RecordApprovalDialog open request={request} onClose={vi.fn()} onRecorded={vi.fn()} />);
    fill('record-approval-reference', 'ref');
    fill('record-approval-signer-name', 'Pat');
    fill('record-approval-signer-email', 'pat@example.com');
    fill('record-approval-note', 'said yes');
    fireEvent.click(screen.getByTestId('record-approval-submit'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    const body = JSON.parse((fetchWithAuth.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ decision: 'approved', signerEmail: 'pat@example.com', note: 'said yes' });
  });

  it('a REQUEST_CHANGED 409 shows localized copy, closes and asks the host to reload', async () => {
    fetchWithAuth.mockResolvedValue(fail(409, { error: 'changed', code: 'REQUEST_CHANGED' }));
    const onRecorded = vi.fn();
    const onClose = vi.fn();
    render(<RecordApprovalDialog open request={request} onClose={onClose} onRecorded={onRecorded} />);
    fill('record-approval-reference', 'ref');
    fill('record-approval-signer-name', 'Pat');
    fireEvent.click(screen.getByTestId('record-approval-submit'));
    await waitFor(() => expect(onRecorded).toHaveBeenCalled());
    expect(showToast.mock.calls[0][0].message).toMatch(/changed/i);
    expect(showToast.mock.calls[0][0].message).not.toBe('changed');
    expect(onClose).toHaveBeenCalled();
  });
});
