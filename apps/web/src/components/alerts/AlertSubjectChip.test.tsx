import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../../lib/i18n';
import germanAlerts from '../../locales/de-DE/alerts.json';
import AlertSubjectChip, { alertSubjectHref, isDeviceAlert } from './AlertSubjectChip';

describe('AlertSubjectChip', () => {
  afterEach(async () => { await i18n.changeLanguage('en'); });

  it('links workload subjects to the backup overview', () => {
    render(<AlertSubjectChip ownerKind="backup_workload" subjectName="Microsoft 365 mail backup · Customer" />);
    expect(screen.getByRole('link', { name: 'Microsoft 365 mail backup · Customer' })).toHaveAttribute('href', '/backup');
  });

  it.each([
    ['device', 'Device', 'Betroffenes Objekt'],
    ['topology_site', 'Topology site', 'Topologiestandort'],
    ['backup_workload', 'SaaS backup', 'Backup-Workload'],
    ['backup_workload', 'SaaS backup · Kunde', 'Backup-Workload · Kunde'],
  ] as const)('localizes the generic %s API label %s', async (ownerKind, subjectName, label) => {
    i18n.addResourceBundle('de-DE', 'alerts', germanAlerts, true, true);
    await i18n.changeLanguage('de-DE');
    render(<AlertSubjectChip ownerKind={ownerKind} subjectName={subjectName} ownerLabel={subjectName} />);
    expect(screen.getByTestId('alert-subject-chip')).toHaveTextContent(label);
  });

  it('preserves named subjects when the console uses another language', async () => {
    i18n.addResourceBundle('de-DE', 'alerts', germanAlerts, true, true);
    await i18n.changeLanguage('de-DE');
    render(<AlertSubjectChip ownerKind="backup_workload" subjectName="Microsoft 365 mail backup · Kunde" />);
    expect(screen.getByTestId('alert-subject-chip')).toHaveTextContent('Microsoft 365 mail backup · Kunde');
  });

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
