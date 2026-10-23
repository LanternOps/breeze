import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
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

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  fetchWithAuth.mockReset();
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
});
