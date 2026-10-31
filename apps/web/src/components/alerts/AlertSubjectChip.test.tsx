import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '../../lib/i18n';
import AlertSubjectChip, { alertSubjectHref, isDeviceAlert } from './AlertSubjectChip';

describe('AlertSubjectChip', () => {
  it('renders a deleted topology subject as text when its site is missing', () => {
    render(<AlertSubjectChip ownerKind="topology_site" subjectName="Former site" />);
    expect(screen.getByTestId('alert-subject-chip')).toHaveTextContent('Former site');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('uses the owner fallback rather than a topology origin device name', () => {
    render(<AlertSubjectChip ownerKind="topology_site" deviceId="origin" deviceName="Origin server" topologySiteId="site-1" />);
    expect(screen.getByTestId('alert-subject-chip')).not.toHaveTextContent('Origin server');
  });

  it('keeps legacy device owners actionable and rejects a null device id', () => {
    expect(isDeviceAlert({ deviceId: 'd1' })).toBe(true);
    expect(alertSubjectHref({ deviceId: 'd1' })).toBe('/devices/d1');
    expect(isDeviceAlert({ ownerKind: 'device', deviceId: null })).toBe(false);
    expect(alertSubjectHref({ ownerKind: 'device', deviceId: null })).toBeUndefined();
  });

  it('never treats a topology provenance device as the action target', () => {
    const alert = { ownerKind: 'topology_site' as const, deviceId: 'origin', topologySiteId: 'site-1' };
    expect(isDeviceAlert(alert)).toBe(false);
    expect(alertSubjectHref(alert)).toBe('/discovery#topology/site/site-1');
  });
});
