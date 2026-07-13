import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('ticket mailbox permission migration', () => {
  const migrationPath = join(
    __dirname,
    '../../migrations/2026-07-15-b-ticket-mailbox-permissions.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');

  it('does not require a nonexistent permissions resource/action unique constraint', () => {
    expect(sql).not.toMatch(/ON\s+CONFLICT\s*\(\s*resource\s*,\s*action\s*\)/i);
    expect(sql).toContain(`UPDATE permissions
SET description = 'View Microsoft 365 ticket mailbox connection status'
WHERE resource = 'ticket_mailbox' AND action = 'read';`);
    expect(sql).toContain(`SELECT 'ticket_mailbox', 'read', 'View Microsoft 365 ticket mailbox connection status'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'ticket_mailbox' AND action = 'read'
);`);
    expect(sql).toContain(`UPDATE permissions
SET description = 'Connect, verify, retest, and disable Microsoft 365 ticket mailboxes'
WHERE resource = 'ticket_mailbox' AND action = 'admin';`);
    expect(sql).toContain(`SELECT 'ticket_mailbox', 'admin', 'Connect, verify, retest, and disable Microsoft 365 ticket mailboxes'
WHERE NOT EXISTS (
  SELECT 1 FROM permissions WHERE resource = 'ticket_mailbox' AND action = 'admin'
);`);
  });
});
