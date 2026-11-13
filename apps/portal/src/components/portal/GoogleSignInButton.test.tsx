// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { GoogleSignInButton } from './GoogleSignInButton';

afterEach(cleanup);

describe('GoogleSignInButton', () => {
  it('renders the standard text and the G mark as an inline SVG', () => {
    render(<GoogleSignInButton onClick={() => {}} />);
    const button = screen.getByTestId('portal-login-google');
    expect(button.textContent).toBe('Sign in with Google');
    const svg = button.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    // The four Google brand colours of the standard G, unmodified.
    const fills = Array.from(svg!.querySelectorAll('path')).map((p) => p.getAttribute('fill')?.toUpperCase());
    expect(new Set(fills)).toEqual(new Set(['#EA4335', '#4285F4', '#FBBC05', '#34A853']));
  });

  it('takes one of the sanctioned labels and a test id', () => {
    render(<GoogleSignInButton onClick={() => {}} label="Continue with Google" testId="portal-accept-invite-google" />);
    expect(screen.getByTestId('portal-accept-invite-google').textContent).toBe('Continue with Google');
  });

  it('calls onClick, and is disabled with a spinner while busy', () => {
    const onClick = vi.fn();
    const { rerender } = render(<GoogleSignInButton onClick={onClick} />);
    fireEvent.click(screen.getByTestId('portal-login-google'));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(<GoogleSignInButton onClick={onClick} busy />);
    const button = screen.getByTestId('portal-login-google') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.querySelector('svg.animate-spin')).not.toBeNull();
  });

  it('loads nothing remote: no script, stylesheet or image URL in the component', () => {
    const src = readFileSync('src/components/portal/GoogleSignInButton.tsx', 'utf8');
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/<script|<img|<link/);
  });
});
