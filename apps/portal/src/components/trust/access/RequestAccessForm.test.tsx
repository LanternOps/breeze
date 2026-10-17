// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const requestAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/trustAccessApi', () => ({ requestAccess }));
import RequestAccessForm from './RequestAccessForm';

beforeEach(() => { requestAccess.mockReset(); requestAccess.mockResolvedValue(undefined); });

function fill() {
  fireEvent.change(screen.getByTestId('trust-access-name'), { target: { value: 'Alice Smith' } });
  fireEvent.change(screen.getByTestId('trust-access-email'), { target: { value: 'alice@corp.example' } });
  fireEvent.change(screen.getByTestId('trust-access-company'), { target: { value: 'Corp' } });
  fireEvent.change(screen.getByTestId('trust-access-purpose'), { target: { value: 'Vendor security review' } });
}

describe('RequestAccessForm', () => {
  it('has bounded, required fields', () => {
    render(<RequestAccessForm partnerSlug="nw" orgSlug="acme" ndaText={null} />);
    expect(screen.getByTestId('trust-access-email')).toHaveAttribute('type', 'email');
    expect(screen.getByTestId('trust-access-email')).toHaveAttribute('maxlength', '320');
    expect(screen.getByTestId('trust-access-name')).toHaveAttribute('minlength', '2');
    expect(screen.getByTestId('trust-access-name')).toBeRequired();
    expect(screen.getByTestId('trust-access-company')).toHaveAttribute('maxlength', '200');
    expect(screen.getByTestId('trust-access-purpose')).toHaveAttribute('minlength', '10');
    expect(screen.getByTestId('trust-access-purpose')).toHaveAttribute('maxlength', '2000');
  });

  it('without ndaText: no NDA box and sends ndaAccepted false', async () => {
    render(<RequestAccessForm partnerSlug="nw" orgSlug={null} ndaText={null} />);
    expect(screen.queryByTestId('trust-access-nda')).toBeNull();
    expect(screen.queryByTestId('trust-access-nda-checkbox')).toBeNull();
    fill();
    fireEvent.click(screen.getByTestId('trust-access-submit'));
    await waitFor(() => expect(screen.getByTestId('trust-access-submitted')).toHaveTextContent('Check your email to confirm the request.'));
    expect(requestAccess).toHaveBeenCalledWith({
      partnerSlug: 'nw', orgSlug: null, email: 'alice@corp.example', name: 'Alice Smith', company: 'Corp',
      purpose: 'Vendor security review', ndaAccepted: false,
    });
  });

  it('with ndaText: renders plain text in a pre, requires the checkbox, sends ndaAccepted true', async () => {
    const nda = '<b>Terms</b>\nline two';
    render(<RequestAccessForm partnerSlug="nw" orgSlug="acme" ndaText={nda} />);
    const box = screen.getByTestId('trust-access-nda');
    const pre = box.querySelector('pre')!;
    expect(pre.textContent).toBe(nda);
    expect(pre.className).toContain('whitespace-pre-wrap');
    expect(box.querySelector('b')).toBeNull();
    const cb = screen.getByTestId('trust-access-nda-checkbox');
    expect(cb).toBeRequired();
    fill();
    // Unticked: native validation blocks submit, so no request is made.
    fireEvent.submit(screen.getByTestId('trust-access-submit').closest('form')!);
    expect(requestAccess).not.toHaveBeenCalled();
    expect(screen.queryByTestId('trust-access-submitted')).toBeNull();
    fireEvent.click(cb);
    fireEvent.click(screen.getByTestId('trust-access-submit'));
    await waitFor(() => expect(requestAccess).toHaveBeenCalledWith(expect.objectContaining({ ndaAccepted: true, orgSlug: 'acme' })));
  });

  it('shows the same confirmation when the request throws', async () => {
    requestAccess.mockRejectedValue(new Error('429'));
    render(<RequestAccessForm partnerSlug="nw" orgSlug="acme" ndaText={null} />);
    fill();
    fireEvent.click(screen.getByTestId('trust-access-submit'));
    await waitFor(() => expect(screen.getByTestId('trust-access-submitted')).toBeInTheDocument());
  });

  it('cancel calls onCancel', () => {
    const onCancel = vi.fn();
    render(<RequestAccessForm partnerSlug="nw" orgSlug="acme" ndaText={null} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('trust-access-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
