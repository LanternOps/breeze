import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ canChoose: true }));
vi.mock('../ReportOwnerScopeField', () => ({
  useDefaultReportOwnerScope: () => ({ canChoose: gate.canChoose, defaultScope: 'organization', needsOrganization: false }),
}));
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: null, organizations: [] }) }));
vi.mock('./seriesApi', () => ({ previewSeriesRecipients: () => new Promise(() => {}) }));

import { CoversControl } from './CoversControl';
import type { CoversValue } from './types';

const ORG: CoversValue = { mode: 'org' };
const PICKER = <div data-testid="org-picker-stub" />;
const SERIES: CoversValue = { mode: 'series', targetMode: 'all', orgIds: [], recipientRule: { primaryContact: true, roles: [] }, internalCc: [] };

describe('CoversControl', () => {
  beforeEach(() => { vi.clearAllMocks(); gate.canChoose = true; });

  it('without the partner-wide gate renders only the host org field', () => {
    gate.canChoose = false;
    render(<CoversControl reportType="device_inventory" value={ORG} onChange={vi.fn()} orgField={PICKER} />);
    expect(screen.getByTestId('org-picker-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('covers-mode-series')).toBeNull();
  });

  it('offers series for an eligible type and combined for a business type', () => {
    const { rerender } = render(<CoversControl reportType="device_inventory" value={ORG} onChange={vi.fn()} />);
    expect(screen.getByTestId('covers-mode-series')).toBeInTheDocument();
    expect(screen.queryByTestId('covers-mode-combined')).toBeNull();
    rerender(<CoversControl reportType="ar_aging" value={ORG} onChange={vi.fn()} />);
    expect(screen.getByTestId('covers-mode-combined')).toBeInTheDocument();
    expect(screen.queryByTestId('covers-mode-series')).toBeNull();
  });

  it('switches to series with the default rule, back to org, and restores the series fields', () => {
    const onChange = vi.fn();
    const { rerender } = render(<CoversControl reportType="device_inventory" value={ORG} onChange={onChange} orgField={PICKER} />);
    fireEvent.click(screen.getByTestId('covers-mode-series'));
    expect(onChange).toHaveBeenLastCalledWith(SERIES);
    const edited = { ...SERIES, targetMode: 'selected', orgIds: ['org-2'] } as CoversValue;
    rerender(<CoversControl reportType="device_inventory" value={edited} onChange={onChange} orgField={PICKER} />);
    expect(screen.queryByTestId('org-picker-stub')).toBeNull();
    fireEvent.click(screen.getByTestId('covers-mode-org'));
    expect(onChange).toHaveBeenLastCalledWith({ mode: 'org' });
    rerender(<CoversControl reportType="device_inventory" value={ORG} onChange={onChange} orgField={PICKER} />);
    expect(screen.getByTestId('org-picker-stub')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('covers-mode-series'));
    expect(onChange).toHaveBeenLastCalledWith(edited);
  });

  // Review Focus 3.
  it('falls back to org when the type stops being series-eligible', () => {
    const onChange = vi.fn();
    render(<CoversControl reportType="threat_detection_review" value={SERIES} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith({ mode: 'org' });
  });

  it('says when a partner-wide user picked a type that cannot fan out', () => {
    render(<CoversControl reportType="threat_detection_review" value={ORG} onChange={vi.fn()} />);
    expect(screen.getByTestId('covers-series-unavailable')).toBeInTheDocument();
  });

  it('locked (series edit) shows no mode choice, only targeting', () => {
    render(<CoversControl reportType="device_inventory" value={SERIES} onChange={vi.fn()} lockMode />);
    expect(screen.queryByTestId('covers-mode-org')).toBeNull();
    expect(screen.getByTestId('series-targeting')).toBeInTheDocument();
    expect(screen.queryByTestId('series-recipients')).toBeNull();
  });

  it('renders the recipients section and the extra slot in series mode only (template modals)', () => {
    const extra = <span data-testid="extra-stub" />;
    const { rerender } = render(<CoversControl reportType="hardware_lifecycle" value={SERIES} onChange={vi.fn()} withSeriesRecipients seriesExtra={extra} />);
    expect(screen.getByTestId('series-recipients')).toBeInTheDocument();
    expect(screen.getByTestId('covers-series-extra')).toContainElement(screen.getByTestId('extra-stub'));
    rerender(<CoversControl reportType="hardware_lifecycle" value={ORG} onChange={vi.fn()} withSeriesRecipients seriesExtra={extra} />);
    expect(screen.queryByTestId('extra-stub')).toBeNull();
  });
});
