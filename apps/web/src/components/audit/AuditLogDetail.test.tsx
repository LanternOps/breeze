import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import '@/lib/i18n';
import AuditLogDetail, { type AuditLogEntry } from './AuditLogDetail';

const entry = (user: Partial<AuditLogEntry['user']>): AuditLogEntry => ({
  id: 'e1',
  timestamp: '2026-10-01T12:00:00.000Z',
  action: 'script.execute',
  resource: 'Disk cleanup',
  resourceType: 'script',
  details: '{}',
  ipAddress: '10.0.0.1',
  userAgent: 'test',
  sessionId: '',
  user: { name: 'Dana Admin', email: 'dana@example.com', role: 'user', ...user } as AuditLogEntry['user'],
  changes: { before: {}, after: {} },
});

// #9672
describe('AuditLogDetail user info', () => {
  it('shows the actor type without a dangling separator when no department exists', () => {
    const { container } = render(<AuditLogDetail entry={entry({})} isOpen onClose={() => {}} />);
    expect(screen.getByText('dana@example.com')).toBeTruthy();
    expect(container.textContent).not.toContain('user - ');
    expect(container.textContent).not.toMatch(/user\s*-\s*$/m);
  });
});

// #9941: no before-state is stored and non-update actions carry no after-state,
// so the snapshot must not render empty "{}" blocks.
describe('AuditLogDetail changes snapshot', () => {
  const withChanges = (changes: AuditLogEntry['changes']): AuditLogEntry => ({ ...entry({}), changes });

  it('shows a "no field changes" note instead of empty BEFORE {} / AFTER {} blocks', () => {
    const { container } = render(
      <AuditLogDetail entry={withChanges({ before: {}, after: {} })} isOpen onClose={() => {}} />
    );
    expect(screen.getByTestId('audit-detail-no-changes')).toBeTruthy();
    expect(screen.queryByTestId('audit-detail-before')).toBeNull();
    expect(screen.queryByTestId('audit-detail-after')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('shows only the side that has recorded fields', () => {
    render(
      <AuditLogDetail entry={withChanges({ before: {}, after: { name: 'Renamed' } })} isOpen onClose={() => {}} />
    );
    expect(screen.queryByTestId('audit-detail-no-changes')).toBeNull();
    expect(screen.queryByTestId('audit-detail-before')).toBeNull();
    expect(screen.getByTestId('audit-detail-after').textContent).toContain('"name": "Renamed"');
  });

  it('shows both sides when both have recorded fields', () => {
    render(
      <AuditLogDetail
        entry={withChanges({ before: { name: 'Old' }, after: { name: 'New' } })}
        isOpen
        onClose={() => {}}
      />
    );
    expect(screen.getByTestId('audit-detail-before').textContent).toContain('"name": "Old"');
    expect(screen.getByTestId('audit-detail-after').textContent).toContain('"name": "New"');
  });

  it('treats a missing changes object as no field changes', () => {
    const e = { ...entry({}) } as Partial<AuditLogEntry>;
    delete e.changes;
    render(<AuditLogDetail entry={e as AuditLogEntry} isOpen onClose={() => {}} />);
    expect(screen.getByTestId('audit-detail-no-changes')).toBeTruthy();
  });
});
