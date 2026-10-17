// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallerVerifyWindow } from './CallerVerifyWindow';
import { messages } from './callerVerifyMessages';

const req = {
  verificationId: '11111111-1111-4111-8111-111111111111',
  username: 'alex',
  technicianName: 'Sam',
  orgName: 'Acme',
  actionLabel: 'reset the password',
  targetLabel: 'alex@example.com',
  reverseCode: '7319',
  choices: ['42', '17', '86'],
  timeoutMs: 30000,
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CallerVerifyWindow', () => {
  it('shows exact action/target, three choices, reverse code and safety copy; double click submits once', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    render(
      <CallerVerifyWindow
        req={req}
        deadlineMs={Date.now() + 30000}
        branding={{ partnerName: 'Northwind', logoUrl: null }}
        locale="en"
        onDecision={send}
      />,
    );
    expect(screen.getByText('7319')).toBeTruthy();
    expect(screen.getByText(/reset the password for alex@example.com/)).toBeTruthy();
    expect(screen.getByText(/number you already have/)).toBeTruthy();
    expect(screen.getByText('Northwind')).toBeTruthy();
    for (const c of req.choices) {
      expect(screen.getByRole('button', { name: c })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: '42' }));
    fireEvent.click(screen.getByRole('button', { name: '42' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('42');
  });

  it('falls back to Breeze text without branding and renders only https logos', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { container, rerender } = render(
      <CallerVerifyWindow req={req} deadlineMs={Date.now() + 30000} branding={null} locale="en" onDecision={send} />,
    );
    expect(screen.getByText('Breeze')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    rerender(
      <CallerVerifyWindow
        req={req}
        deadlineMs={Date.now() + 30000}
        branding={{ partnerName: 'N', logoUrl: 'http://example.com/l.png' }}
        locale="en"
        onDecision={send}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    rerender(
      <CallerVerifyWindow
        req={req}
        deadlineMs={Date.now() + 30000}
        branding={{ partnerName: 'N', logoUrl: 'https://example.com/l.png' }}
        locale="en"
        onDecision={send}
      />,
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/l.png');
  });

  it('timeout never chooses a number and fires once', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    render(
      <CallerVerifyWindow req={req} deadlineMs={Date.now() + 1000} branding={null} locale="en" onDecision={send} />,
    );
    await act(async () => {
      vi.advanceTimersByTime(1001);
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('timeout');
  });

  it('does not restart the deadline when it re-renders', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue(undefined);
    const deadline = Date.now() + 2000;
    const { rerender } = render(
      <CallerVerifyWindow req={req} deadlineMs={deadline} branding={null} locale="en" onDecision={send} />,
    );
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    rerender(
      <CallerVerifyWindow req={req} deadlineMs={deadline} branding={{ partnerName: 'X', logoUrl: null }} locale="en" onDecision={send} />,
    );
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(send).toHaveBeenCalledWith('timeout');
  });

  it('not-me is explicit and a failed send stays visible and retryable', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    render(
      <CallerVerifyWindow req={req} deadlineMs={Date.now() + 30000} branding={null} locale="en" onDecision={send} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'This is not me' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not send');
    expect(send).toHaveBeenCalledWith('not_me');
    fireEvent.click(screen.getByRole('button', { name: 'This is not me' }));
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('renders request text as plain text, never HTML', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <CallerVerifyWindow
        req={{ ...req, actionLabel: '<img src=x onerror=alert(1)>' }}
        deadlineMs={Date.now() + 30000}
        branding={null}
        locale="en"
        onDecision={send}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeTruthy();
  });

  it('uses the translated card for non-English locales', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    render(
      <CallerVerifyWindow req={req} deadlineMs={Date.now() + 30000} branding={null} locale="de-DE" onDecision={send} />,
    );
    expect(screen.getByRole('button', { name: messages['de-DE']!.notMe })).toBeTruthy();
  });
});

describe('callerVerifyMessages', () => {
  it('ships eight translated cards', () => {
    expect(Object.keys(messages).sort()).toEqual(['de-DE', 'en', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR']);
    for (const [locale, copy] of Object.entries(messages)) {
      expect(Object.keys(copy).sort()).toEqual(Object.keys(messages.en!).sort());
      if (locale !== 'en') {
        expect(copy.safety('Sam', 'Northwind')).not.toBe(messages.en!.safety('Sam', 'Northwind'));
        expect(copy.title).not.toBe(messages.en!.title);
      }
    }
  });
});
