import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKLOAD_UPSTREAM_STATUSES } from '@breeze/shared';
import '@/lib/i18n';
import DeviceWorkloadsTab from './DeviceWorkloadsTab';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const runtime = {
  runtime: 'docker', detection: 'present', collection: 'ok', complete: true, runtimeVersion: '27.1.0',
  observedCount: 9, reportedCount: 9, lastError: null, collectedAt: '2026-10-12T10:00:00.000Z',
  lastAttemptAt: '2026-10-12T10:00:00.000Z', lastSuccessAt: '2026-10-12T10:00:00.000Z',
};

const container = (name: string, upstreamStatus: string | undefined) => ({
  id: name, runtime: 'docker', kind: 'container', workloadId: name, name, state: 'running', rawState: 'running',
  imageRef: `${name}:1`, imageRepository: name, imageTag: '1', guestOs: null, composeProject: null,
  composeService: null, startedAt: null,
  ...(upstreamStatus === undefined ? {} : { upstreamStatus, upstreamDigest: null, upstreamCheckedAt: null }),
});

const render9 = async () => {
  fetchWithAuthMock.mockResolvedValue(json({
    capability: 1,
    runtimes: [runtime],
    workloads: WORKLOAD_UPSTREAM_STATUSES.map((s) => container(`img-${s}`, s)),
  }));
  render(<DeviceWorkloadsTab deviceId="dev-1" />);
  return screen.findByTestId('workloads-runtime-docker');
};

const badgeFor = (section: HTMLElement, name: string) =>
  within(within(section).getByText(name).closest('tr')!).getByTestId('workloads-image-status');

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  window.location.hash = 'workloads';
});
afterEach(() => {
  window.location.hash = '';
});

describe('DeviceWorkloadsTab image status', () => {
  it('labels every upstream status; unknown-class statuses read "Not checked" and are never green', async () => {
    const section = await render9();
    const label = (s: string) => badgeFor(section, `img-${s}`);
    expect(label('behind').textContent).toBe('Behind');
    expect(label('current').textContent).toBe('Up to date');
    expect(label('pinned').textContent).toBe('Pinned');
    expect(label('local').textContent).toBe('Local build');
    expect(label('not_found').textContent).toBe('Tag not found');
    for (const s of ['pending', 'private', 'unsupported_registry', 'error']) {
      expect(label(s).textContent).toBe('Not checked');
      expect(label(s).className).not.toMatch(/success/);
    }
    expect(label('current').className).toMatch(/success/);
    expect(label('behind').className).toMatch(/warning/);
    expect(label('private').getAttribute('title')).toBe('Private registry — credentials required');
  });

  it('shows no badge for a VM row or a row without an upstream status', async () => {
    fetchWithAuthMock.mockResolvedValue(json({
      capability: 1,
      runtimes: [runtime],
      workloads: [container('old-api', undefined), { ...container('vm1', 'pending'), kind: 'vm', guestOs: 'Ubuntu' }],
    }));
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    const section = await screen.findByTestId('workloads-runtime-docker');
    expect(within(section).queryAllByTestId('workloads-image-status')).toHaveLength(0);
    expect(screen.queryByTestId('workloads-image-filter')).toBeNull();
  });

  it('filters rows by image status and keeps the choice in the URL hash', async () => {
    const section = await render9();
    const filter = screen.getByTestId('workloads-image-filter') as HTMLSelectElement;
    expect(filter.value).toBe('all');
    expect(within(section).getAllByTestId('workloads-row')).toHaveLength(9);

    fireEvent.change(filter, { target: { value: 'not_checked' } });
    expect(window.location.hash).toBe('#workloads/not_checked');
    expect(within(section).getAllByTestId('workloads-row').map((r) => r.querySelector('td')!.textContent)).toEqual([
      'img-pending', 'img-private', 'img-unsupported_registry', 'img-error',
    ]);

    fireEvent.change(filter, { target: { value: 'behind' } });
    expect(window.location.hash).toBe('#workloads/behind');
    expect(within(section).getAllByTestId('workloads-row')).toHaveLength(1);

    fireEvent.change(filter, { target: { value: 'all' } });
    expect(window.location.hash).toBe('#workloads');
    expect(within(section).getAllByTestId('workloads-row')).toHaveLength(9);
  });

  it('adopts the filter from the hash on load and on hash change', async () => {
    window.location.hash = 'workloads/current';
    const section = await render9();
    expect((screen.getByTestId('workloads-image-filter') as HTMLSelectElement).value).toBe('current');
    expect(within(section).getAllByTestId('workloads-row')).toHaveLength(1);
    await act(async () => {
      window.location.hash = 'workloads/pinned';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(within(section).getAllByTestId('workloads-row').map((r) => r.querySelector('td')!.textContent)).toEqual(['img-pinned']);
  });

  it('says so when the filter matches nothing in a runtime', async () => {
    fetchWithAuthMock.mockResolvedValue(json({
      capability: 1, runtimes: [runtime], workloads: [container('a', 'current')],
    }));
    window.location.hash = 'workloads/behind';
    render(<DeviceWorkloadsTab deviceId="dev-1" />);
    const section = await screen.findByTestId('workloads-runtime-docker');
    expect(within(section).queryAllByTestId('workloads-row')).toHaveLength(0);
    expect(within(section).getByText('No workloads match this image status.')).toBeTruthy();
  });
});
