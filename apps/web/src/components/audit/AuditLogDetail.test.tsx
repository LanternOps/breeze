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
