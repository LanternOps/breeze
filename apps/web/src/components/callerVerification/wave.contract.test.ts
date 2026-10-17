/**
 * Caller verification W04 (#6354) mount contracts. Each surface's behaviour
 * (including fail-closed gating) is covered by its own component test; this
 * file pins WHERE the surfaces mount so a refactor of a host page cannot drop
 * one silently, and that no host fetches caller-verification routes itself.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const components = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel: string) => readFileSync(join(components, rel), 'utf8');

describe('caller verification mounts', () => {
  it('partner settings mounts the partner baseline in #security, read-only without partner-wide rights', () => {
    const page = src('settings/PartnerSettingsPage.tsx');
    const security = page.slice(page.indexOf("{activeTab === 'security' && ("), page.indexOf("{activeTab === 'notifications' && ("));
    expect(security).toContain('<PartnerCallerVerificationPolicy />');
  });

  it('org settings mounts the org override in #security', () => {
    const page = src('settings/OrgSettingsPage.tsx');
    const security = page.slice(page.indexOf("case 'security':"), page.indexOf("case 'approval-security':"));
    expect(security).toMatch(/<CallerVerificationPolicyForm\s+owner=\{\{ ownerScope: 'organization', orgId: effectiveOrgId \}\}/);
  });

  it('host pages never call caller-verification routes directly', () => {
    for (const host of ['settings/PartnerSettingsPage.tsx', 'settings/OrgSettingsPage.tsx', 'settings/ContactsCard.tsx', 'tickets/TicketWorkbench.tsx', 'ai/AiChatMessages.tsx']) {
      expect(src(host), host).not.toMatch(/['"`][^'"`]*\/caller-verification/);
    }
  });
});
