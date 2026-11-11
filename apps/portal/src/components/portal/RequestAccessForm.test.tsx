// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn().mockResolvedValue(undefined) }));

import { RequestAccessForm } from './RequestAccessForm';

const SERVER_MESSAGE = "If this address can request access, we've emailed you.";
const originalFetch = globalThis.fetch;
let reply: { status: number; body: unknown } | 'throw';
const calls: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  reply = { status: 200, body: { success: true, message: SERVER_MESSAGE } };
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (reply === 'throw') throw new Error('offline');
    const { status, body } = reply;
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

async function fillAndSubmit(name: string, email: string) {
  fireEvent.change(screen.getByTestId('request-access-name'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('request-access-email'), { target: { value: email } });
  fireEvent.click(screen.getByTestId('request-access-submit'));
}

describe('RequestAccessForm', () => {
  it('posts the name and email to the self-register route, and nothing else', async () => {
    render(<RequestAccessForm />);
    await fillAndSubmit('  Pat Doe ', 'pat@contoso.example.com');
    await screen.findByTestId('request-access-sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/portal\/auth\/self-register$/);
    expect(calls[0]!.body).toEqual({ name: 'Pat Doe', email: 'pat@contoso.example.com' });
  });

  it('the form shows the same confirmation for every 200', async () => {
    // The server answers every address the same way; the page must not add a
    // difference of its own (no per-address copy, no second request).
    const rendered: string[] = [];
    for (const email of ['pat@verified.example.com', 'sam@unknown.example.com', 'kim@existing.example.com']) {
      const { unmount } = render(<RequestAccessForm />);
      await fillAndSubmit('Pat', email);
      const sent = await screen.findByTestId('request-access-sent');
      expect(sent.textContent).toContain(SERVER_MESSAGE);
      rendered.push(sent.innerHTML);
      unmount();
    }
    expect(new Set(rendered).size).toBe(1);
  });

  it('a 429 says try again later and keeps the form', async () => {
    reply = { status: 429, body: { error: 'Too many requests. Please try again later.' } };
    render(<RequestAccessForm />);
    await fillAndSubmit('Pat', 'pat@contoso.example.com');
    expect((await screen.findByRole('alert')).textContent).toContain('Too many requests');
    expect(screen.queryByTestId('request-access-sent')).toBeNull();
    expect(screen.getByTestId('request-access-submit')).toBeTruthy();
  });

  it('a 404 (self-registration off on this server) says it is not available here', async () => {
    reply = { status: 404, body: { error: 'Not found' } };
    render(<RequestAccessForm />);
    await fillAndSubmit('Pat', 'pat@contoso.example.com');
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn't available here/);
  });

  it('a 400 or a network failure shows a generic error, never a per-address one', async () => {
    reply = { status: 400, body: { error: 'validation' } };
    render(<RequestAccessForm />);
    await fillAndSubmit('Pat', 'pat@contoso.example.com');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Check your name and email/);
    cleanup();

    reply = 'throw';
    render(<RequestAccessForm />);
    await fillAndSubmit('Pat', 'pat@contoso.example.com');
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn't send your request/);
  });

  it('validates locally before posting: a bad address or an empty name sends nothing', async () => {
    render(<RequestAccessForm />);
    // Submit the form directly: jsdom's native type=email check would block a
    // button click before the schema runs (a browser shows its own bubble).
    const submitForm = (name: string, email: string) => {
      fireEvent.change(screen.getByTestId('request-access-name'), { target: { value: name } });
      fireEvent.change(screen.getByTestId('request-access-email'), { target: { value: email } });
      fireEvent.submit(screen.getByTestId('request-access-form'));
    };
    submitForm('Pat', 'not-an-email');
    expect(await screen.findByText('Please enter a valid email address')).toBeTruthy();
    submitForm('   ', 'pat@contoso.example.com');
    expect(await screen.findByText('Please enter your name')).toBeTruthy();
    submitForm('Pat\u202Eevil', 'pat@contoso.example.com');
    expect(await screen.findByText('Remove the special characters from your name')).toBeTruthy();
    await waitFor(() => expect(calls).toHaveLength(0));
  });
});
