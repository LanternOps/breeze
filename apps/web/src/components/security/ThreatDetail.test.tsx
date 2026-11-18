import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));

import ThreatDetail from './ThreatDetail';

function ok(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
}
function fail(status: number): Response {
  return { ok: false, status, statusText: String(status), json: async () => ({}) } as Response;
}

const quarantinedThreat = {
  id: 't1',
  deviceId: 'dev-1',
  deviceName: 'Workstation 1',
  name: 'Emotet',
  category: 'trojan',
  severity: 'critical',
  status: 'quarantined',
  detectedAt: '2026-06-20T00:00:00Z',
  filePath: 'C:\\temp\\evil.exe',
};

const yaraRule = {
  engine: 'yara',
  ruleName: 'ioc_advisory_md5_0123456789abcdef',
  ruleId: 'r1',
  ruleSetId: 's1',
  ruleSet: { id: 's1', name: 'Advisory set', isBuiltin: false, partnerWide: false },
  tags: ['ioc'],
  matchedStrings: [],
  sha256: 'b'.repeat(64),
  quarantinedTo: null,
  quarantineFailed: false,
};

/** Routes `/details` and the list separately, like the real API. */
function route({ details, list }: { details: Response; list: Response }) {
  fetchWithAuth.mockImplementation(async (url: string) => (url.endsWith('/details') ? details : list));
}

/** Serves `threat` from /details (the PR's source of truth) and as the sole list item. */
function detailsFor(threat: Record<string, unknown>) {
  route({ details: ok({ data: { threat, rule: yaraRule } }), list: ok({ data: [threat] }) });
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('ThreatDetail', () => {
  // #6685 -- status/severity rendered the raw lowercase enum value instead of
  // a human label.
  it('renders human-readable status and severity labels, not raw enum values', async () => {
    route({ details: ok({ data: { threat: quarantinedThreat, rule: yaraRule } }), list: ok({ data: [quarantinedThreat] }) });

    render(<ThreatDetail threatId="t1" />);

    await screen.findByText('Emotet');

    const statusLabels = screen.getAllByText('Quarantined');
    expect(statusLabels.length).toBeGreaterThan(0);
    const severityLabels = screen.getAllByText('Critical');
    expect(severityLabels.length).toBeGreaterThan(0);
    expect(screen.queryByText('quarantined')).toBeNull();
    expect(screen.queryByText('critical')).toBeNull();
  });

  // #6267 W04-5: the selected threat comes from /details, so a threat beyond
  // the first 100 list items (or absent from the list) still renders.
  it('renders a threat that is not in the first 100 list items, with its rule panel', async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({ ...quarantinedThreat, id: `other-${i}`, name: `Other ${i}` }));
    route({ details: ok({ data: { threat: quarantinedThreat, rule: yaraRule } }), list: ok({ data: others }) });

    render(<ThreatDetail threatId="t1" />);
    await settle();

    expect(screen.getByRole('heading', { name: 'Emotet' })).toBeTruthy();
    expect(fetchWithAuth).toHaveBeenCalledWith('/security/threats/t1/details');
    expect(screen.getByTestId('threat-rule-name').textContent).toBe('ioc_advisory_md5_0123456789abcdef');
  });

  it('passes agent-escaped matched strings through untouched — a stored \\x00 renders as four characters', async () => {
    const rule = { ...yaraRule, matchedStrings: [{ id: '$i0', offset: 12, data: 'MZ\\x00\\x90' }] };
    route({ details: ok({ data: { threat: quarantinedThreat, rule } }), list: ok({ data: [quarantinedThreat] }) });

    render(<ThreatDetail threatId="t1" />);
    await settle();

    const row = screen.getByTestId('threat-rule-string-0').textContent ?? '';
    expect(row).toContain('MZ\\x00\\x90');
    expect(row).not.toContain('\\\\x00');
    expect(row).not.toContain('\u0000');
  });

  it('a 404 from /details is not found, never another threat from the list', async () => {
    route({ details: fail(404), list: ok({ data: [{ ...quarantinedThreat, id: 'x9', name: 'Somebody else' }] }) });

    render(<ThreatDetail threatId="t1" />);
    await settle();

    expect(screen.queryByText('Somebody else')).toBeNull();
    expect(screen.getByTestId('security-threat-detail-not-found')).toBeInTheDocument();
  });

  it('a failed related-threats read is surfaced, not shown as "no related threats"', async () => {
    route({ details: ok({ data: { threat: quarantinedThreat, rule: yaraRule } }), list: fail(500) });

    render(<ThreatDetail threatId="t1" />);
    await settle();

    expect(screen.getByRole('heading', { name: 'Emotet' })).toBeTruthy();
    expect(screen.getByTestId('security-threat-related-error')).toBeInTheDocument();
    expect(screen.queryByText('No related threats.')).toBeNull();
  });

  // #9660 -- the timeline was synthesized from status and stamped every entry
  // with the detection time, plus an unconditional "Analyst review".
  it('shows only events that have a record: no invented analyst review, no fake timestamps', async () => {
    detailsFor({ ...quarantinedThreat, status: 'active' });
    render(<ThreatDetail threatId="t1" />);
    await screen.findByText('Emotet');

    expect(screen.queryByText('Analyst review')).toBeNull();
    expect(screen.queryByText('Threat quarantined')).toBeNull();
    expect(screen.queryByText('Threat removed')).toBeNull();
    expect(screen.getByText('Threat detected')).toBeTruthy();
  });

  it('does not stamp a quarantine event with the detection time', async () => {
    detailsFor(quarantinedThreat);
    render(<ThreatDetail threatId="t1" />);
    await screen.findByText('Emotet');

    const entry = screen.getByText('Threat quarantined').parentElement as HTMLElement;
    // title + description only; no timestamp line.
    expect(entry.querySelectorAll('p')).toHaveLength(2);
  });

  it('stamps a removal event with removedAt, not detectedAt', async () => {
    detailsFor({ ...quarantinedThreat, status: 'removed', removedAt: '2026-06-21T12:00:00Z' });
    render(<ThreatDetail threatId="t1" />);
    await screen.findByText('Emotet');

    const entry = screen.getByText('Threat removed').parentElement as HTMLElement;
    expect(entry.querySelectorAll('p')).toHaveLength(3);
    const detected = screen.getByText('Threat detected').parentElement as HTMLElement;
    expect(entry.querySelectorAll('p')[2].textContent).not.toBe(detected.querySelectorAll('p')[2].textContent);
  });

  it('shows the catalog provider name instead of the raw id', async () => {
    detailsFor({
      ...quarantinedThreat,
      providerId: 'breeze',
      provider: { id: 'breeze', name: 'Breeze IOC scan' },
    });
    render(<ThreatDetail threatId="t1" />);
    await screen.findByText('Emotet');

    expect(screen.getByText('Breeze IOC scan')).toBeTruthy();
    expect(screen.queryByText('breeze')).toBeNull();
  });

  it('toasts a queued action as queued, not as completed', async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: { method?: string }) =>
      init?.method === 'POST'
        ? ok({ data: { id: 't1' } })
        : url.endsWith('/details')
          ? ok({ data: { threat: { ...quarantinedThreat, status: 'active' }, rule: yaraRule } })
          : ok({ data: [{ ...quarantinedThreat, status: 'active' }] }),
    );
    render(<ThreatDetail threatId="t1" />);
    await screen.findByText('Emotet');

    fireEvent.click(screen.getByRole('button', { name: 'Quarantine' }));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const toast = showToast.mock.calls[0][0] as { message: string };
    expect(toast.message).toMatch(/queued/i);
    expect(toast.message).not.toBe('Threat quarantined');
  });
});
