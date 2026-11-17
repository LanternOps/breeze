import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && Object.keys(opts).length > 0 ? `${key}|${JSON.stringify(opts)}` : key,
  }),
}));

import RunChainSection, { analysisScopeLabel } from './RunChainSection';
import { formatCurrency } from '@/lib/i18n/format';

const steps = [
  { id: 'r0', step: 1, continuedFromRunId: null, goal: 'export inventory', status: 'completed', costCents: 35, queuedAt: '2026-11-13T10:00:00.000Z' },
  { id: 'r1', step: 2, continuedFromRunId: 'r0', goal: '<img src=x onerror=alert(1)>', status: 'failed', costCents: 12, queuedAt: '2026-11-13T10:05:00.000Z' },
  { id: 'r2', step: 2, continuedFromRunId: 'r0', goal: null, status: 'running', costCents: 0, queuedAt: '2026-11-13T10:06:00.000Z' },
] as const;

describe('RunChainSection (W06)', () => {
  it('renders nothing without a chain, including when the field is absent', () => {
    expect(render(<RunChainSection steps={null} currentRunId="r0" />).container.innerHTML).toBe('');
    expect(render(<RunChainSection steps={undefined} currentRunId="r0" />).container.innerHTML).toBe('');
  });

  it('lists every step in order with goal, status, cost and a link, and marks the current run instead of linking it', () => {
    const { getByTestId, queryByTestId, getAllByRole } = render(<RunChainSection steps={[...steps]} currentRunId="r1" />);
    expect(getByTestId('run-detail-chain')).toBeTruthy();
    expect(getAllByRole('listitem').map((li) => li.getAttribute('data-testid')))
      .toEqual(['run-detail-chain-step-r0', 'run-detail-chain-step-r1', 'run-detail-chain-step-r2']);
    expect(getByTestId('run-detail-chain-link-r0').getAttribute('href')).toBe('/ai-agents/runs/r0');
    expect(queryByTestId('run-detail-chain-link-r1')).toBeNull();
    expect(getByTestId('run-detail-chain-step-r1').querySelector('[data-testid="run-detail-chain-current"]')).not.toBeNull();
    expect(getByTestId('run-detail-chain-step-r2').textContent).toContain('aiAgentsPage.runs.detail.chain.noGoal');
  });

  it('renders each step number, status and cost', () => {
  const { getByTestId } = render(<RunChainSection steps={[...steps]} currentRunId="r1" />);
  const r0 = getByTestId('run-detail-chain-step-r0').textContent!;
  expect(r0).toContain('aiAgentsPage.runs.detail.chain.step|{"step":1}');
  expect(r0).toContain('aiAgentsPage.runs.statuses.completed');
  expect(r0).toContain(formatCurrency(0.35));
  const r1 = getByTestId('run-detail-chain-step-r1').textContent!;
  expect(r1).toContain('aiAgentsPage.runs.detail.chain.step|{"step":2}');
  expect(r1).toContain('aiAgentsPage.runs.statuses.failed');
  expect(r1).toContain(formatCurrency(0.12));
});

it('renders a goal as text, never as markup', () => {
    const { getByTestId } = render(<RunChainSection steps={[...steps]} currentRunId="r0" />);
    expect(getByTestId('run-detail-chain-step-r1').querySelector('img')).toBeNull();
    expect(getByTestId('run-detail-chain-step-r1').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('analysisScopeLabel picks the key by kind and falls back when the site name is unknown', () => {
    const t = (k: string, o?: Record<string, unknown>) => `${k}|${JSON.stringify(o)}`;
    expect(analysisScopeLabel(t as never, { kind: 'org', siteId: null, siteName: null, deviceCount: 412 }))
      .toBe('aiAgentsPage.runs.detail.scope.org|{"count":412}');
    expect(analysisScopeLabel(t as never, { kind: 'site', siteId: 's', siteName: 'HQ', deviceCount: 3 }))
      .toBe('aiAgentsPage.runs.detail.scope.site|{"count":3,"name":"HQ"}');
    expect(analysisScopeLabel(t as never, { kind: 'site', siteId: 's', siteName: null, deviceCount: 3 }))
      .toBe('aiAgentsPage.runs.detail.scope.siteUnnamed|{"count":3}');
    expect(analysisScopeLabel(t as never, { kind: 'devices', siteId: null, siteName: null, deviceCount: 2 }))
      .toBe('aiAgentsPage.runs.detail.scope.devices|{"count":2}');
  });
});
