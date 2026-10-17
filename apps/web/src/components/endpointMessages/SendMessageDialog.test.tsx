import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SendMessageDialog, { type MessageTargetDevice } from './SendMessageDialog';
import { fetchWithAuth } from '@/stores/auth';
import { runAction } from '@/lib/runAction';

vi.mock('@/stores/auth', async () => {
  const actual = await vi.importActual<typeof import('@/stores/auth')>('@/stores/auth');
  return { ...actual, fetchWithAuth: vi.fn() };
});

vi.mock('@/lib/runAction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/runAction')>('@/lib/runAction');
  return {
    ...actual,
    runAction: vi.fn(async (opts: { request: () => Promise<Response> }) => {
      const res = await opts.request();
      const data = await res.json();
      if (!res.ok) throw new actual.ActionError('failed', res.status, undefined, data);
      return data;
    }),
  };
});

const fetchMock = vi.mocked(fetchWithAuth);
const runActionMock = vi.mocked(runAction);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function devices(n: number, agentVersion = '0.100.0'): MessageTargetDevice[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    hostname: `host-${i}`,
    osType: 'windows' as const,
    agentVersion,
  }));
}

function lastBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]!;
  return JSON.parse(String((call[1] as RequestInit).body));
}

async function compose(title = 'Reboot tonight', body = 'Please save your work.\nSecond line') {
  await userEvent.type(screen.getByTestId('send-message-title'), title);
  // userEvent treats "\n" in type() as Enter, which is what a textarea wants.
  await userEvent.type(screen.getByTestId('send-message-body'), body);
}

const okResponse = (n = 1) => ({
  batchId: 'b1',
  deviceCount: n,
  results: [{ deviceId: 'd1', orgId: 'o1', status: 'queued', commandId: 'c1' }],
});

describe('SendMessageDialog', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    runActionMock.mockClear();
    window.history.replaceState(null, '', '/devices');
  });

  it('posts through runAction to /endpoint-messages with the composed message', async () => {
    fetchMock.mockResolvedValue(json(okResponse()));
    const ds = devices(2);
    render(<SendMessageDialog open onClose={() => {}} targets={{ deviceIds: ds.map((d) => d.id) }} devices={ds} />);
    await compose();
    await userEvent.click(screen.getByTestId('send-message-submit'));

    await waitFor(() => expect(runActionMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/endpoint-messages');
    expect((init as RequestInit).method).toBe('POST');
    expect(lastBody()).toMatchObject({
      title: 'Reboot tonight',
      body: 'Please save your work.\nSecond line',
      severity: 'info',
      requiresAck: false,
      expiresInMinutes: 1440,
      targets: { deviceIds: ds.map((d) => d.id) },
    });
    expect(lastBody().messageId).toMatch(UUID);
    expect(lastBody()).not.toHaveProperty('confirmedCount');
    await screen.findByTestId('send-message-result');
  });

  it('preview shows exactly the submitted title and body', async () => {
    fetchMock.mockResolvedValue(json(okResponse()));
    const ds = devices(1);
    render(<SendMessageDialog open onClose={() => {}} targets={{ deviceIds: [ds[0]!.id] }} devices={ds} />);
    await compose('Maintenance soon', 'Line one\nLine two');
    const previewTitle = screen.getByTestId('message-preview-title').textContent;
    const previewBody = screen.getByTestId('message-preview-body').textContent;
    expect(screen.getByTestId('message-preview-card').textContent).toContain('Sent by your IT provider');
    await userEvent.click(screen.getByTestId('send-message-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastBody().title).toBe(previewTitle);
    expect(lastBody().body).toBe(previewBody);
    expect(previewTitle).toBe('Maintenance soon');
    expect(previewBody).toBe('Line one\nLine two');
  });

  it('requires the confirm step above 100 devices and sends confirmedCount', async () => {
    fetchMock.mockResolvedValue(json(okResponse(101)));
    const ds = devices(101);
    render(<SendMessageDialog open onClose={() => {}} targets={{ deviceIds: ds.map((d) => d.id) }} devices={ds} />);
    await compose();
    await userEvent.click(screen.getByTestId('send-message-submit'));

    expect(fetchMock).not.toHaveBeenCalled();
    await screen.findByTestId('send-message-confirm');
    expect(screen.getByTestId('send-message-confirm-count').textContent).toContain('101');
    expect(screen.getByTestId('message-preview-title').textContent).toBe('Reboot tonight');
    expect(window.location.hash).toBe('#send-message=confirm');

    await userEvent.click(screen.getByTestId('send-message-confirm-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastBody().confirmedCount).toBe(101);
  });

  it('moves to the confirm step on 409 confirmation_required and resends with confirmedCount', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'confirmation_required', deviceCount: 250 }, 409))
      .mockResolvedValueOnce(json(okResponse(250)));
    render(<SendMessageDialog open onClose={() => {}} targets={{ siteIds: ['00000000-0000-4000-8000-0000000000aa'] }} />);
    await compose();
    await userEvent.click(screen.getByTestId('send-message-submit'));
    await screen.findByTestId('send-message-confirm');
    expect(screen.getByTestId('send-message-confirm-count').textContent).toContain('250');
    const firstId = lastBody().messageId;

    await userEvent.click(screen.getByTestId('send-message-confirm-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastBody().confirmedCount).toBe(250);
    expect(lastBody().messageId).toBe(firstId);
  });

  it('reuses the same messageId when the user retries after a failure', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: 'boom' }, 500))
      .mockResolvedValueOnce(json(okResponse()));
    const ds = devices(1);
    render(<SendMessageDialog open onClose={() => {}} targets={{ deviceIds: [ds[0]!.id] }} devices={ds} />);
    await compose();
    await userEvent.click(screen.getByTestId('send-message-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const first = lastBody().messageId;
    await waitFor(() => expect(screen.getByTestId('send-message-submit')).not.toBeDisabled());
    await userEvent.click(screen.getByTestId('send-message-submit'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(lastBody().messageId).toBe(first);
  });

  it('shows unsupported in the capability column for an old agent version', () => {
    const ds = devices(1, '0.100.0');
    render(<SendMessageDialog open onClose={() => {}} targets={{ deviceIds: [ds[0]!.id] }} devices={ds} />);
    expect(screen.getByTestId(`send-message-capability-${ds[0]!.id}`).getAttribute('data-capability')).toBe('unsupported');
  });

  it('explains a 403 feature_disabled response', async () => {
    fetchMock.mockResolvedValue(json({ error: 'feature_disabled' }, 403));
    const ds = devices(1);
    render(<SendMessageDialog open onClose={() => {}} targets={{ deviceIds: [ds[0]!.id] }} devices={ds} />);
    await compose();
    await userEvent.click(screen.getByTestId('send-message-submit'));
    const el = await screen.findByTestId('send-message-error');
    expect(el.textContent).toContain('Endpoint messaging is not enabled for this organization');
  });

  it('labels per-device failures in the result list', async () => {
    fetchMock.mockResolvedValue(
      json({
        batchId: 'b',
        deviceCount: 2,
        results: [
          { deviceId: 'd1', orgId: 'o', status: 'queued', commandId: 'c' },
          { deviceId: 'd2', orgId: 'o', status: 'failed', errorCode: 'agent_unsupported' },
        ],
      }),
    );
    const ds = devices(2);
    render(<SendMessageDialog open onClose={() => {}} targets={{ deviceIds: ds.map((d) => d.id) }} devices={ds} />);
    await compose();
    await userEvent.click(screen.getByTestId('send-message-submit'));
    const row = await screen.findByTestId('send-message-result-d2');
    expect(row.getAttribute('data-error-code')).toBe('agent_unsupported');
    expect(row.textContent).toContain('agent');
    fireEvent.click(screen.getByTestId('send-message-close'));
  });

  it.each([
    ['in_progress', 409, 'already being sent'],
    ['unavailable', 503, 'temporarily unavailable'],
    ['no_devices_resolved', 400, 'No devices matched'],
    ['idempotency_conflict', 409, 'already used for a different message'],
  ])('shows a specific localized message for the %s error code', async (code, status, text) => {
    fetchMock.mockResolvedValue(json({ error: code }, status));
    const ds = devices(1);
    render(<SendMessageDialog open onClose={() => {}} targets={{ deviceIds: [ds[0]!.id] }} devices={ds} />);
    await compose();
    await userEvent.click(screen.getByTestId('send-message-submit'));
    const el = await screen.findByTestId('send-message-error');
    expect(el.textContent).toContain(text);
  });

  it('renders content issues as localized messages, never the validator\'s raw English', async () => {
    const ds = devices(1);
    render(<SendMessageDialog open onClose={() => {}} targets={{ deviceIds: [ds[0]!.id] }} devices={ds} />);
    fireEvent.change(screen.getByTestId('send-message-title'), { target: { value: '<b>x</b>' } });
    fireEvent.change(screen.getByTestId('send-message-body'), { target: { value: '![i](https://a.example/i.png) <b>y</b> [z](http://a.example)' } });
    const list = screen.getByTestId('send-message-issues');
    expect(list.textContent).not.toMatch(/is not allowed$|must use https$|body:|title:/m);
    expect(list.textContent).toContain('Images are not allowed in the message body.');
    expect(list.textContent).toContain('HTML is not allowed in the message body.');
    expect(list.textContent).toContain('Links in the message body must use https.');
    expect(list.textContent).toContain('HTML is not allowed in the title.');
  });
});
