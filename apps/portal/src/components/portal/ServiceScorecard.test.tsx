// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ServiceScorecard } from './ServiceScorecard';
import type { PortalServiceOverviewDto } from '@breeze/shared';

vi.mock('@/lib/api', () => ({
  portalApi: {
    getServiceOccurrences: vi.fn(),
    documentContentUrl: (id: string) => `/api/v1/portal/documents/${id}/content`,
    reportArtifactUrl: (id: string) => `/api/v1/portal/reports/runs/${id}/pdf`,
  },
}));

const overview: PortalServiceOverviewDto = {
  asOf: '2026-10-15T12:00:00.000Z',
  timezone: 'America/Denver',
  groups: [{
    source: 'contract',
    contract: { id: 'c1', name: 'Best plan' },
    deliverables: [{
      id: 'd1', name: 'Monthly sign-in log review', description: 'We read every sign-in',
      cadence: 'monthly', artifactRequired: true, nextDue: '2026-10-31', status: 'on_track',
      lastDelivered: { at: '2026-09-30T17:00:00.000Z', late: false, note: 'Nothing unusual',
                       artifactState: 'attached',
                       evidence: [{ kind: 'document', documentId: 'doc1', reportRunId: null,
                                    title: 'September findings', createdAt: '2026-09-30T17:00:00.000Z' }] },
    }],
  }],
  keyDates: [{ source: 'contract_end', id: 'c1', label: 'Best plan', kind: 'contract_end',
               date: '2027-03-31', notes: null }],
};

describe('ServiceScorecard', () => {
  it('names the contract the deliverables belong to', () => {
    render(<ServiceScorecard overview={overview} />);
    expect(screen.getByTestId('portal-service-group-c1')).toHaveTextContent('Best plan');
    expect(screen.getByTestId('portal-service-row-d1')).toHaveTextContent('Monthly sign-in log review');
  });

  it('links attached evidence at the portal download path', () => {
    render(<ServiceScorecard overview={overview} />);
    expect(screen.getByTestId('portal-service-evidence-0-d1'))
      .toHaveAttribute('href', '/api/v1/portal/documents/doc1/content');
  });

  it('says the artifact is held by the MSP rather than pretending it exists', () => {
    const held = structuredClone(overview);
    held.groups[0]!.deliverables[0]!.lastDelivered!.artifactState = 'held_by_msp';
    held.groups[0]!.deliverables[0]!.lastDelivered!.evidence = [];
    render(<ServiceScorecard overview={held} />);
    expect(screen.getByTestId('portal-service-row-d1'))
      .toHaveTextContent('Delivered (artifact held by your IT team)');
  });

  it('shows an honest empty state, not a blank page', () => {
    render(<ServiceScorecard overview={{ ...overview, groups: [], keyDates: [] }} />);
    expect(screen.getByTestId('portal-service-empty')).toBeInTheDocument();
  });
});
