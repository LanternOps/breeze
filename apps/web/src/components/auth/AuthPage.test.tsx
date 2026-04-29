import { render, screen, fireEvent, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Mock the heavy children — this test only exercises tab-switch behavior.
vi.mock('./LoginPage', () => ({
  default: ({ next }: { next?: string }) => (
    <div data-testid="mock-login" data-next={next ?? ''} />
  ),
}));
vi.mock('./PartnerRegisterPage', () => ({
  default: ({ next }: { next?: string }) => (
    <div data-testid="mock-register" data-next={next ?? ''} />
  ),
}));

import AuthPage from './AuthPage';

describe('AuthPage', () => {
  beforeEach(() => {
    // Clean any leftover hash between tests
    window.location.hash = '';
  });

  afterEach(() => {
    window.location.hash = '';
  });

  it('renders the sign-in tab by default', () => {
    render(<AuthPage />);
    expect(screen.getByTestId('mock-login')).toBeTruthy();
    expect(screen.queryByTestId('mock-register')).toBeNull();
    expect(screen.getByTestId('tab-signin').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('tab-signup').getAttribute('aria-selected')).toBe('false');
  });

  it('switches to signup when the Create account tab is clicked and updates the hash', () => {
    render(<AuthPage />);
    fireEvent.click(screen.getByTestId('tab-signup'));
    expect(window.location.hash).toBe('#signup');
    expect(screen.getByTestId('mock-register')).toBeTruthy();
    expect(screen.queryByTestId('mock-login')).toBeNull();
  });

  it('honors #signup hash present at mount', () => {
    window.location.hash = '#signup';
    render(<AuthPage />);
    expect(screen.getByTestId('mock-register')).toBeTruthy();
    expect(screen.queryByTestId('mock-login')).toBeNull();
  });

  it('reacts to external hashchange events', () => {
    render(<AuthPage />);
    expect(screen.getByTestId('mock-login')).toBeTruthy();
    act(() => {
      window.location.hash = '#signup';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByTestId('mock-register')).toBeTruthy();
  });

  it('forwards `next` to the active child unchanged (children own validation)', () => {
    render(<AuthPage next="/oauth/consent?uid=abc" />);
    expect(screen.getByTestId('mock-login').getAttribute('data-next')).toBe('/oauth/consent?uid=abc');
  });

  it('forwards an unsafe `next` unchanged — LoginPage/PartnerRegisterPage rewrite it before navigating', () => {
    render(<AuthPage next="https://evil.example.com" />);
    expect(screen.getByTestId('mock-login').getAttribute('data-next')).toBe('https://evil.example.com');
  });
});
