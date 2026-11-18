// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SignaturePanel } from './SignaturePanel';

afterEach(cleanup);

const base = { onDecline: vi.fn(), busy: false, testIdPrefix: 'p' };

describe('SignaturePanel', () => {
  it('keeps the default quote copy byte-for-byte', () => {
    render(<SignaturePanel {...base} onAccept={vi.fn()} />);
    const panel = screen.getByTestId('p-sign');
    expect(panel.querySelector('h3')?.textContent).toBe('Accept & sign');
    expect(panel.querySelector('p')?.textContent).toBe('Type your full legal name to sign and accept this proposal.');
    expect(screen.getByTestId('p-accept').textContent).toBe('Accept & sign');
    expect(screen.queryByTestId('p-signer-email')).toBeNull();
  });

  it('allows heading and intro overrides', () => {
    render(<SignaturePanel {...base} onAccept={vi.fn()} heading="Sign this agreement" intro="Custom intro." />);
    const panel = screen.getByTestId('p-sign');
    expect(panel.querySelector('h3')?.textContent).toBe('Sign this agreement');
    expect(panel.querySelector('p')?.textContent).toBe('Custom intro.');
  });

  it('gates signing on a plausible email when requireSignerEmail is set and passes it on', () => {
    const onAccept = vi.fn();
    render(<SignaturePanel {...base} onAccept={onAccept} requireSignerEmail />);
    fireEvent.change(screen.getByTestId('p-signer'), { target: { value: 'Jane Doe' } });
    fireEvent.click(screen.getByTestId('p-agree'));
    const email = screen.getByTestId('p-signer-email') as HTMLInputElement;
    expect(email.type).toBe('email');
    fireEvent.click(screen.getByTestId('p-accept'));
    expect(onAccept).not.toHaveBeenCalled();
    fireEvent.change(email, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByTestId('p-accept'));
    expect(onAccept).not.toHaveBeenCalled();
    fireEvent.change(email, { target: { value: '  Jane@Example.COM ' } });
    fireEvent.click(screen.getByTestId('p-accept'));
    expect(onAccept).toHaveBeenCalledWith('Jane Doe', 'jane@example.com');
  });

  it('keeps the default consent + decline copy naming the proposal', () => {
    render(<SignaturePanel {...base} onAccept={vi.fn()} />);
    expect(screen.getByTestId('p-agree').closest('label')?.textContent).toBe(
      'I have reviewed this proposal and the terms. Typing my name above is my electronic signature.',
    );
    fireEvent.click(screen.getByTestId('p-decline'));
    const panel = screen.getByTestId('p-decline-panel');
    expect(panel.querySelector('h4')?.textContent).toBe('Decline this proposal?');
    expect(panel.querySelector('p')?.textContent).toBe('This tells the sender you are not going ahead. You cannot accept the proposal afterwards.');
  });

  it('documentNoun renames the document in the consent and decline copy (agreement page)', () => {
    render(<SignaturePanel {...base} onAccept={vi.fn()} documentNoun="agreement" />);
    expect(screen.getByTestId('p-agree').closest('label')?.textContent).toBe(
      'I have reviewed this agreement and the terms. Typing my name above is my electronic signature.',
    );
    fireEvent.click(screen.getByTestId('p-decline'));
    const panel = screen.getByTestId('p-decline-panel');
    expect(panel.querySelector('h4')?.textContent).toBe('Decline this agreement?');
    expect(panel.textContent).not.toContain('proposal');
  });

  it('does not require or pass an email by default', () => {
    const onAccept = vi.fn();
    render(<SignaturePanel {...base} onAccept={onAccept} />);
    fireEvent.change(screen.getByTestId('p-signer'), { target: { value: 'Jane Doe' } });
    fireEvent.click(screen.getByTestId('p-agree'));
    fireEvent.click(screen.getByTestId('p-accept'));
    expect(onAccept).toHaveBeenCalledWith('Jane Doe');
  });
});
