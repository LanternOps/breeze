// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({ updateTrustPage: vi.fn() }));
vi.mock('@/lib/api/trustPage', () => api);
import TrustControlsSection from './TrustControlsSection';

const page = (over: Record<string, unknown> = {}) => ({
  id: 'pg', orgId: 'o1', isPartnerHome: false, publishedAt: null, publicationRevision: 3, searchIndexable: false,
  showPercentages: false, showDeviceCount: false, showManagedBy: true, securityContactEmail: null, websiteUrl: null,
  introHtml: null, hiddenControlIds: [], publicationAuthorizedBy: null, publicationAuthorizedAt: null, lastEvaluatedAt: null, ...over,
});
/** Mirror of the API's GET effective block: page value when set, else the built-in default. */
const effectiveOf = (pg: Record<string, unknown>) => {
  const d: Record<string, unknown> = { introHtml: null, searchIndexable: false, showPercentages: false, showDeviceCount: false, showManagedBy: true, showHistory: false, hiddenControlIds: [], frameworkView: ['nist_csf_2'] };
  const values: Record<string, unknown> = {}; const sources: Record<string, string> = {};
  for (const k of Object.keys(d)) { const v = pg[k]; values[k] = v ?? d[k]; sources[k] = v == null ? 'default' : 'page'; }
  if (values.introHtml === '') values.introHtml = null;
  return { values, sources };
};
const state = (over: Record<string, unknown> = {}, effectiveOver: Record<string, unknown> = {}) => {
  const pg = page(over);
  const effective = effectiveOf(pg);
  return {
    page: pg, publicPath: '/p', badgePath: '/b',
    slugs: { partnerSlug: 'a', orgSlug: 'b', valid: true, problems: [] }, canPublish: { allowed: true, reason: null },
    effective: { ...effective, values: { ...effective.values, ...effectiveOver } },
  };
};
const def = (id: string, category: string, rank: number, title: string) => ({ id, category, title, description: `${title} d`, source: 'telemetry', metric: 'coverage_pct', unit: 'devices', insurerRank: rank, frameworkRefs: [{ framework: 'cis_v8', ref: '10.1' }] });
const asm = (id: string, category: string, status: string, percent: number | null) => ({ id, category, source: 'telemetry', unit: 'devices', status, reason: null, percent, assessed: 9, eligible: 10, evidenceAsOf: null, frameworkRefs: [] });
const controls = {
  catalog: [def('edr_coverage', 'endpoint_protection', 1, 'EDR coverage'), def('disk_encryption', 'data_protection', 2, 'Disk encryption')],
  assessments: [asm('edr_coverage', 'endpoint_protection', 'met', 92), asm('disk_encryption', 'data_protection', 'attention', 71)],
  evaluatedAt: new Date().toISOString(), deviceCount: 10,
};
const ok = () => new Response(JSON.stringify({ data: {} }), { status: 200 });
const orgFetch = vi.fn() as never;
const mount = (over: { canWrite?: boolean; pageOver?: Record<string, unknown>; effectiveOver?: Record<string, unknown> } = {}) => {
  const onReload = vi.fn(async () => {});
  render(<TrustControlsSection orgId="o1" orgFetch={orgFetch} state={state(over.pageOver, over.effectiveOver) as never} controls={controls as never} canWrite={over.canWrite ?? true} onReload={onReload} />);
  return onReload;
};

describe('TrustControlsSection', () => {
  beforeEach(() => { vi.clearAllMocks(); api.updateTrustPage.mockResolvedValue(ok()); });
  it('renders a pill, percent and assessed count per control', () => {
    mount();
    expect(screen.getByTestId('trust-control-pill-edr_coverage')).toHaveTextContent(/Met/);
    expect(screen.getByTestId('trust-control-pill-disk_encryption')).toBeInTheDocument();
    expect(screen.getByTestId('trust-control-row-edr_coverage')).toHaveTextContent('92%');
    expect(screen.getByTestId('trust-control-row-edr_coverage')).toHaveTextContent('9 of 10 assessed');
    expect(screen.getByTestId('trust-control-row-edr_coverage')).toHaveTextContent('CIS v8');
  });
  it('hiding a control sends the updated hiddenControlIds, then reloads', async () => {
    const onReload = mount();
    fireEvent.click(screen.getByTestId('trust-control-switch-edr_coverage'));
    await waitFor(() => expect(api.updateTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { hiddenControlIds: ['edr_coverage'] }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });
  it('showing a hidden control removes it from hiddenControlIds', async () => {
    mount({ pageOver: { hiddenControlIds: ['edr_coverage', 'disk_encryption'] } });
    fireEvent.click(screen.getByTestId('trust-control-switch-edr_coverage'));
    await waitFor(() => expect(api.updateTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { hiddenControlIds: ['disk_encryption'] }));
  });
  it('W2: an inherited (null) page value displays the EFFECTIVE value', () => {
    mount({ pageOver: { showPercentages: null, hiddenControlIds: null }, effectiveOver: { showPercentages: true, hiddenControlIds: ['disk_encryption'] } });
    expect(screen.getByTestId('trust-toggle-showPercentages')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('trust-control-switch-disk_encryption')).toHaveAttribute('aria-checked', 'false');
  });
  it('W2: toggling an inherited value writes an explicit page value', async () => {
    mount({ pageOver: { showPercentages: null }, effectiveOver: { showPercentages: true } });
    fireEvent.click(screen.getByTestId('trust-toggle-showPercentages'));
    await waitFor(() => expect(api.updateTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { showPercentages: false }));
  });
  it('toggling percentages sends showPercentages: true', async () => {
    mount();
    fireEvent.click(screen.getByTestId('trust-toggle-showPercentages'));
    await waitFor(() => expect(api.updateTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { showPercentages: true }));
  });
  it('reverts the optimistic toggle when the save fails', async () => {
    api.updateTrustPage.mockResolvedValue(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    const onReload = mount();
    const sw = screen.getByTestId('trust-toggle-showDeviceCount');
    fireEvent.click(sw);
    await waitFor(() => expect(api.updateTrustPage).toHaveBeenCalled());
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
    expect(onReload).not.toHaveBeenCalled();
  });
  it('shows the republish banner only when published', () => {
    mount({ pageOver: { publishedAt: '2026-10-01T00:00:00Z' } });
    expect(screen.getByTestId('trust-controls-published-banner')).toHaveTextContent('Changes apply to the public page when you publish again.');
  });
  it('has no banner when unpublished, and disables everything without write', () => {
    mount({ canWrite: false });
    expect(screen.queryByTestId('trust-controls-published-banner')).toBeNull();
    expect(screen.getByTestId('trust-control-switch-edr_coverage')).toBeDisabled();
    expect(screen.getByTestId('trust-toggle-searchIndexable')).toBeDisabled();
  });
});
