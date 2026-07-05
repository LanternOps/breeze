import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CreateVulnTicketModal } from './CreateVulnTicketModal';
import type { GroupFinding } from '../../lib/api/vulnerabilities';

function finding(overrides: Partial<GroupFinding> = {}): GroupFinding {
  return {
    deviceVulnerabilityId: 'dv-1',
    deviceId: 'dev-1',
    deviceName: 'WS-01',
    orgId: 'org-1',
    orgName: 'Acme',
    cveId: 'CVE-2026-0001',
    status: 'open',
    patchAvailable: true,
    riskScore: 95,
    detectedAt: '2026-06-01T00:00:00.000Z',
    acceptedUntil: null,
    ticketId: null,
    ticketNumber: null,
    ...overrides,
  };
}

describe('CreateVulnTicketModal', () => {
  it('pre-fills the title and a description listing CVEs and devices', () => {
    render(
      <CreateVulnTicketModal
        findings={[finding(), finding({ deviceVulnerabilityId: 'dv-2', deviceId: 'dev-2', deviceName: 'WS-02', cveId: 'CVE-2026-0002' })]}
        defaultTitle="Remediate Google Chrome"
        busy={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByTestId('vuln-ticket-title')).toHaveValue('Remediate Google Chrome');
    const description = screen.getByTestId('vuln-ticket-description');
    expect((description as HTMLTextAreaElement).value).toContain('CVE-2026-0001');
    expect((description as HTMLTextAreaElement).value).toContain('WS-02');
  });

  it('warns when the selection spans multiple organizations', () => {
    render(
      <CreateVulnTicketModal
        findings={[finding(), finding({ deviceVulnerabilityId: 'dv-2', orgId: 'org-2', orgName: 'Beta' })]}
        defaultTitle="T"
        busy={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByTestId('vuln-ticket-cross-org-note')).toHaveTextContent('2 organizations');
  });

  it('is a named dialog and closes on Escape without submitting', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(<CreateVulnTicketModal findings={[finding()]} defaultTitle="T" busy={false} onCancel={onCancel} onSubmit={onSubmit} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Create ticket — 1 finding');
    fireEvent.keyDown(screen.getByTestId('vuln-ticket-modal'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores Escape and disables buttons while busy', () => {
    const onCancel = vi.fn();
    render(<CreateVulnTicketModal findings={[finding()]} defaultTitle="T" busy onCancel={onCancel} onSubmit={() => {}} />);
    fireEvent.keyDown(screen.getByTestId('vuln-ticket-modal'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('vuln-ticket-cancel')).toBeDisabled();
    expect(screen.getByTestId('vuln-ticket-submit')).toBeDisabled();
  });

  it('submits title/description/priority and blocks empty titles', () => {
    const onSubmit = vi.fn();
    render(<CreateVulnTicketModal findings={[finding()]} defaultTitle="T" busy={false} onCancel={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId('vuln-ticket-title'), { target: { value: '' } });
    expect(screen.getByTestId('vuln-ticket-submit')).toBeDisabled();
    fireEvent.change(screen.getByTestId('vuln-ticket-title'), { target: { value: 'Patch it' } });
    fireEvent.change(screen.getByTestId('vuln-ticket-priority'), { target: { value: 'high' } });
    fireEvent.click(screen.getByTestId('vuln-ticket-submit'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: 'Patch it', priority: 'high' }));
  });
});
