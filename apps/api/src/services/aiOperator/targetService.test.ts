// apps/api/src/services/aiOperator/targetService.test.ts
import { describe, expect, it, vi } from 'vitest';
import {
  CONTACT_LINK_SYSTEMS,
  createTaskTarget,
  freezeTargetAccount,
  targetColumnForKind,
} from './targetService';

describe('targetService — kind/pointer agreement (recipe spec §5.1)', () => {
  it('maps each target kind to exactly one pointer column', () => {
    expect(targetColumnForKind('device')).toBe('deviceId');
    expect(targetColumnForKind('ticket')).toBe('ticketId');
    expect(targetColumnForKind('contact')).toBe('contactId');
  });

  it('refuses a target whose pointer does not match its kind, BEFORE the DB sees it', async () => {
    const dbh = { insert: vi.fn(), update: vi.fn(), select: vi.fn() } as never;
    await expect(createTaskTarget(dbh, {
      orgId: 'org-1', taskId: 'task-1', targetKind: 'contact',
      deviceId: 'device-1', contactId: null, targetLabel: 'Dana', targetOrdinal: 0,
    })).rejects.toThrow(/target_kind 'contact' requires contactId/);
    // The CHECK constraint would also catch this, but a 23514 inside the
    // admission transaction aborts it and surfaces as a 500. Refuse first.
    expect((dbh as unknown as { insert: ReturnType<typeof vi.fn> }).insert).not.toHaveBeenCalled();
  });

  it('refuses more than one pointer even when one of them matches the kind', async () => {
    const dbh = { insert: vi.fn(), update: vi.fn(), select: vi.fn() } as never;
    await expect(createTaskTarget(dbh, {
      orgId: 'org-1', taskId: 'task-1', targetKind: 'device',
      deviceId: 'device-1', ticketId: 'ticket-1', targetLabel: 'host', targetOrdinal: 0,
    })).rejects.toThrow(/exactly one pointer/);
  });

  it('truncates target_label to the column bound', async () => {
    const values = vi.fn(() => ({ returning: async () => [{ id: 'target-1' }] }));
    const dbh = { insert: vi.fn(() => ({ values })), update: vi.fn(), select: vi.fn() } as never;
    await createTaskTarget(dbh, {
      orgId: 'org-1', taskId: 'task-1', targetKind: 'device',
      deviceId: 'device-1', targetLabel: 'h'.repeat(400), targetOrdinal: 0,
    });
    expect((values.mock.calls[0][0] as { targetLabel: string }).targetLabel.length).toBe(255);
  });

  it('writes the connection id into the column its provider names, and nulls the other', async () => {
    const values = vi.fn(() => ({ onConflictDoUpdate: () => ({ returning: async () => [{ id: 'acct-1' }] }) }));
    const dbh = { insert: vi.fn(() => ({ values })), update: vi.fn(), select: vi.fn() } as never;
    await freezeTargetAccount(dbh, {
      orgId: 'org-1', taskId: 'task-1', targetId: 'target-1', provider: 'google',
      connectionId: 'conn-1', externalId: '1234567890', principalLabel: 'dana@acme.com',
    });
    expect(values.mock.calls[0][0]).toMatchObject({
      provider: 'google', googleConnectionId: 'conn-1', m365ConnectionId: null,
    });
  });

  it('pins the contact_external_links system vocabulary to m365 and google', () => {
    // `contact_external_links.system` is free-form text with no CHECK
    // (2026-08-19-contacts.sql) and is shared with the CSV/PSA importers, so
    // the Operator's own vocabulary has to be pinned in code or a typo would
    // create a second, silently-unmatched identity for the same person.
    expect([...CONTACT_LINK_SYSTEMS]).toEqual(['m365', 'google']);
  });
});
