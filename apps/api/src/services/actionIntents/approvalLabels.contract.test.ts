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

  it('prettifies an unmapped tool instead of showing the identifier', () => {
    expect(buildApprovalDescription('some_unmapped_tool', 'do_thing', {})).toBe('Some unmapped tool: do thing');
  });
});
