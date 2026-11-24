import { describe, expect, it } from 'vitest';

import { TIER3_ACTIONS, buildApprovalDescription } from '../aiGuardrails';
import { getAllRegisteredToolNames, getToolTier } from '../aiTools';

// #9657: an approval card must never headline the raw tool identifier.
describe('approval card labels (#9657)', () => {
  const tier3Tools = getAllRegisteredToolNames().filter((n) => getToolTier(n) === 3);

  it('has tier-3 tools to check', () => {
    expect(tier3Tools.length).toBeGreaterThan(10);
  });

  it.each(tier3Tools)('%s has a human label, not its identifier', (toolName) => {
    const label = buildApprovalDescription(toolName, undefined, {});
    expect(label).not.toBe(toolName);
    expect(label).not.toMatch(/[a-z]_[a-z]/);
  });

  it.each(Object.entries(TIER3_ACTIONS).flatMap(([t, as]) => as.map((a) => [t, a] as const)))(
    '%s:%s has a human label',
    (toolName, action) => {
      const label = buildApprovalDescription(toolName, action, {});
      expect(label).not.toMatch(/[a-z]_[a-z]/);
    },
  );

  // W17 (#6788): what the approver is signing, and where it goes. Copied from the plan's approval copy.
  it('W17 backup verification and C2C config writes state what they do', () => {
    const device = '0123456789abcdef';
    expect(buildApprovalDescription('manage_backup_verification', 'run', { deviceId: device, verificationType: 'integrity' }))
      .toBe('Run a backup integrity check on device 01234567.... Queues a command on the machine.');
    expect(buildApprovalDescription('manage_backup_verification', 'run', { deviceId: device, verificationType: 'test_restore' }))
      .toBe('Run a backup test restore check on device 01234567.... Queues a command on the machine.');
    expect(buildApprovalDescription('manage_backup_verification', 'run', { deviceId: device }))
      .toBe('Run a backup integrity check on device 01234567.... Queues a command on the machine.');
    expect(buildApprovalDescription('manage_c2c_configs', 'create', {
      name: 'Finance', backupScope: 'mail', targetUsers: ['a@example.test', 'b@example.test'], schedule: { frequency: 'daily' },
    })).toBe('Create cloud-to-cloud backup config Finance: mail for 2 users, schedule daily.');
    expect(buildApprovalDescription('manage_c2c_configs', 'create', { name: 'All', backupScope: 'files' }))
      .toBe('Create cloud-to-cloud backup config All: files for 0 users, schedule none.');
    expect(buildApprovalDescription('manage_c2c_configs', 'update', { configId: device, targetUsers: ['a@example.test'], isActive: true, action: 'update', orgId: device }))
      .toBe('Update cloud-to-cloud backup config 01234567...: targetUsers, isActive.');
    expect(buildApprovalDescription('manage_c2c_configs', 'update', { configId: device, name: 'Renamed' }))
      .toBe('Update cloud-to-cloud backup config 01234567...: name.');
    expect(buildApprovalDescription('manage_c2c_configs', 'delete', { configId: device }))
      .toBe('Delete cloud-to-cloud backup config 01234567.... Refused if it has backup history.');
  });

  it('names the specific action for the finance and M365 write tools', () => {
    expect(buildApprovalDescription('manage_invoices', 'void', {})).toBe('Void invoice');
    expect(buildApprovalDescription('manage_invoices', 'record_payment', {})).toBe('Record invoice payment');
    expect(buildApprovalDescription('manage_invoices', 'void_payment', {})).toBe('Void invoice payment');
    expect(buildApprovalDescription('manage_quotes', 'send', {})).toBe('Send quote');
    expect(buildApprovalDescription('manage_contracts', 'cancel', {})).toBe('Cancel contract');
    expect(buildApprovalDescription('m365_reset_password', undefined, {})).toBe('Reset Microsoft 365 password');
    expect(buildApprovalDescription('restore_snapshot', undefined, {})).toBe('Restore backup snapshot');
    expect(buildApprovalDescription('trigger_backup', undefined, {})).toBe('Start a backup');
    expect(buildApprovalDescription('remediate_vulnerability', undefined, {})).toBe('Remediate vulnerabilities');
  });

  // W02 (#6756) call-specific copy keeps its detail when the id is present,
  // and its non-special actions use the same humanized fallback (merge with #9657).
  it('W02 write tools: specific copy with an id, humanized fallback otherwise', () => {
    expect(buildApprovalDescription('manage_quotes', 'send', { quoteId: '0123456789abcdef' }))
      .toBe('Send quote 01234567... to the customer');
    expect(buildApprovalDescription('manage_quotes', 'create', {})).toBe('Create quote');
    expect(buildApprovalDescription('manage_billing_catalog', 'create_item', {}))
      .toBe('Manage billing catalog: create item');
    expect(buildApprovalDescription('manage_notification_channels', 'test', {}))
      .toBe('Manage notification channels: test');
  });

  it('prettifies an unmapped tool instead of showing the identifier', () => {
    expect(buildApprovalDescription('some_unmapped_tool', 'do_thing', {})).toBe('Some unmapped tool: do thing');
  });
});


describe('W15 Pax8 approval consequences', () => {
  it('explains the billing link, unlink refusal, partner sync and vendor dry run', () => {
    expect(buildApprovalDescription('manage_pax8_subscriptions', 'link', {})).toContain('decides which contract line later Pax8 orders bill');
    expect(buildApprovalDescription('manage_pax8_subscriptions', 'unlink', {})).toContain('staged changes on this subscription will be refused');
    expect(buildApprovalDescription('manage_pax8_subscriptions', 'sync', {})).toContain('every organization');
    expect(buildApprovalDescription('manage_pax8_orders', 'preflight', {})).toContain('sends the staged order content to Pax8');
  });
});

// #11674: a comment edit or delete acts on `expectedTicketId` (intentRowTarget.ts),
// so its headline names that ticket, by an id stub the intent service swaps for
// the ticket number. Never the comment text (aiGuardrails.ts `manage_tickets`).
describe('comment edit and delete headlines (#11674)', () => {
  const OPERATIVE = '7c1e9d02-aaaa-4bbb-8ccc-ddddeeeeffff';
  const STRAY = '2aad0601-1111-4222-8333-444455556666';

  it('edit_comment names the expectedTicketId ticket and says the text is replaced', () => {
    const label = buildApprovalDescription('manage_tickets', 'edit_comment', {
      action: 'edit_comment', commentId: STRAY, expectedTicketId: OPERATIVE, ticketId: STRAY, content: 'secret replacement text',
    });
    expect(label).toBe('Edit a comment on ticket #7c1e9d02... (replaces its text)');
    expect(label).not.toContain('secret');
  });

  it('delete_comment names the expectedTicketId ticket', () => {
    expect(buildApprovalDescription('manage_tickets', 'delete_comment', {
      action: 'delete_comment', commentId: STRAY, expectedTicketId: OPERATIVE, ticketId: STRAY,
    })).toBe('Delete a comment on ticket #7c1e9d02...');
  });

  it('never names a stray ticketId when expectedTicketId is missing', () => {
    expect(buildApprovalDescription('manage_tickets', 'delete_comment', { action: 'delete_comment', ticketId: STRAY }))
      .toBe('Delete a comment on ticket #unknown');
  });
});

// A supervised patch install headlined "Install 1 patch(es) on 1 device(s)":
// it now counts in plain English, and one device is named by the
// `on device <id>...` stub the approval surfaces swap for its name
// (approvalDeviceName.ts `argumentDeviceId`), as run_script does (#11979).
describe('manage_patches install headline', () => {
  const DEVICE = '6eae0f70-1111-4222-8333-444455556666';
  const OTHER_DEVICE = '7eae0f70-1111-4222-8333-444455556666';
  const PATCH = 'aaaaaaaa-1111-4222-8333-444455556666';
  const PATCH_2 = 'bbbbbbbb-1111-4222-8333-444455556666';

  it('one patch on one device names the device by its stub', () => {
    expect(buildApprovalDescription('manage_patches', 'install', { action: 'install', patchIds: [PATCH], deviceIds: [DEVICE] }))
      .toBe('Install 1 patch on device 6eae0f70...');
  });

  it('counts several patches and devices without "(es)" or "(s)"', () => {
    expect(buildApprovalDescription('manage_patches', 'install', {
      action: 'install', patchIds: [PATCH, PATCH_2], deviceIds: [DEVICE, OTHER_DEVICE],
    })).toBe('Install 2 patches on 2 devices');
    expect(buildApprovalDescription('manage_patches', 'install', { action: 'install', patchIds: [PATCH, PATCH_2], deviceIds: [DEVICE] }))
      .toBe('Install 2 patches on device 6eae0f70...');
  });

  it('counts a device it cannot stub', () => {
    expect(buildApprovalDescription('manage_patches', 'install', { action: 'install', patchIds: [PATCH], deviceIds: [42] }))
      .toBe('Install 1 patch on 1 device');
    expect(buildApprovalDescription('manage_patches', 'install', {})).toBe('Install 0 patches on 0 devices');
  });
});
