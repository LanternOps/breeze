import { render, screen, fireEvent, act } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Mock the heavy children — this test only exercises tab-switch / gating behavior.
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

// Control the runtime registration gate. Default to enabled+loaded so the
// existing tab-behavior tests exercise the open-registration path; individual
// tests below override it for the disabled / not-yet-loaded cases.
const registrationGate = vi.hoisted(() => ({ enabled: true, loaded: true }));
vi.mock('../../stores/featuresStore', () => ({
  useRegistrationGate: () => registrationGate,
}));

import AuthPage from './AuthPage';

describe('AuthPage', () => {
  beforeEach(() => {
    // Clean any leftover hash between tests
    window.location.hash = '';
    registrationGate.enabled = true;
    registrationGate.loaded = true;
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
    render(<AuthPage next="/oauth/consent?uid=abc" />);
    fireEvent.click(screen.getByTestId('tab-signup'));
    expect(window.location.hash).toBe('#signup');
    const register = screen.getByTestId('mock-register');
    expect(register).toBeTruthy();
    // `next` is forwarded to the registration form, not only the login form.
    expect(register.getAttribute('data-next')).toBe('/oauth/consent?uid=abc');
    expect(screen.queryByTestId('mock-login')).toBeNull();
  });

  it('still renders the sign-in view while the gate is loading (default route, no hash)', () => {
    // Every normal visitor lands here before /config resolves; the sign-in view
    // must render immediately rather than leaving the page blank. The tablist
    // stays hidden until registration is confirmed open.
    registrationGate.enabled = false;
    registrationGate.loaded = false;
    render(<AuthPage />);
    expect(screen.getByTestId('mock-login')).toBeTruthy();
    expect(screen.queryByTestId('tab-signup')).toBeNull();
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

  describe('registration disabled (#1979)', () => {
    it('hides the Create account tab when registration is disabled', () => {
      registrationGate.enabled = false;
      registrationGate.loaded = true;
      render(<AuthPage />);
      expect(screen.queryByTestId('tab-signup')).toBeNull();
      expect(screen.queryByTestId('tab-signin')).toBeNull();
      // Sign-in view still renders without the tablist.
      expect(screen.getByTestId('mock-login')).toBeTruthy();
    });

    it('shows a closed notice instead of the form for a direct /auth#signup link when disabled', () => {
      registrationGate.enabled = false;
      registrationGate.loaded = true;
      window.location.hash = '#signup';
      render(<AuthPage />);
      expect(screen.getByTestId('registration-disabled-notice')).toBeTruthy();
      // Critically: the registration form is NOT rendered.
      expect(screen.queryByTestId('mock-register')).toBeNull();
    });

    it('exposes the closed notice as a polite live region for screen readers', () => {
      // A directly-shared /auth#signup link lands a screen-reader user on this
      // notice; live-region semantics ensure the "registration closed" context
      // is announced rather than silently swapped in.
      registrationGate.enabled = false;
      registrationGate.loaded = true;
      window.location.hash = '#signup';
      render(<AuthPage />);
      const notice = screen.getByTestId('registration-disabled-notice');
      expect(notice.getAttribute('role')).toBe('status');
      expect(notice.getAttribute('aria-live')).toBe('polite');
    });

    it('lets the user return to sign in from the closed notice', () => {
      registrationGate.enabled = false;
      registrationGate.loaded = true;
      window.location.hash = '#signup';
      render(<AuthPage />);
      fireEvent.click(screen.getByTestId('back-to-signin'));
      expect(window.location.hash).toBe('#signin');
      expect(screen.getByTestId('mock-login')).toBeTruthy();
      expect(screen.queryByTestId('registration-disabled-notice')).toBeNull();
    });

    it('does not flash the form or the notice while the gate is still loading', () => {
      registrationGate.enabled = false;
      registrationGate.loaded = false;
      window.location.hash = '#signup';
      render(<AuthPage />);
      expect(screen.queryByTestId('mock-register')).toBeNull();
      expect(screen.queryByTestId('registration-disabled-notice')).toBeNull();
    });
  });
});
