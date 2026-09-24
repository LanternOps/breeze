/**
 * Partner-wide scripts through the read tools, under REAL RLS as `breeze_app`.
 *
 * run_script can execute a partner-wide script (org_id NULL) from an
 * org-scoped caller, so the read tools must show the caller exactly those rows
 * and their content digest, and nothing from another partner:
 *   - an org API key context (apiKeyAuth: currentPartnerId = owning partner,
 *     no partner-axis grant) sees its own partner's partner-wide script in
 *     get_script_details and list_scripts, with `version` and `contentSha256`;
 *   - it never sees another partner's partner-wide script;
 *   - without currentPartnerId (the pre-fix context) RLS hides the row even
 *     though the app-layer predicate would allow it.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, type SQL } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { scriptVersions } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { aiTools } from '../../services/aiTools';
import { compactToolResultForChat } from '../../services/aiToolOutput';
import { insertScriptRow } from '../../services/scriptWrite';
import { sha256Content } from '../../services/scriptVersions';
import { createOrganization, createPartner, createUser } from './db-utils';

async function partnerWideScript(partnerId: string, userId: string, name: string, content: string) {
  const auth = { scope: 'system', user: { id: userId } } as unknown as Pick<AuthContext, 'scope' | 'user'>;
  const row = await withSystemDbAccessContext(() =>
    insertScriptRow(auth, { orgId: null, partnerId }, {
      name, osTypes: ['windows'], language: 'powershell', content, timeoutSeconds: 120, runAs: 'system',
    }),
  );
  if (!row) throw new Error('script insert failed');
  return row;
}

function orgKeyAuth(orgId: string): AuthContext {
  return {
    scope: 'organization',
    orgId,
    partnerId: null,
    accessibleOrgIds: [orgId],
    user: { id: null, email: 'org-key@example.test' },
    canAccessOrg: (id: string) => id === orgId,
    orgCondition: (col: unknown) => eq(col as never, orgId) as SQL,
  } as unknown as AuthContext;
}

function orgKeyContext(orgId: string, currentPartnerId: string | null) {
  // Mirrors apiKeyAuthMiddleware for an ordinary (non-provisioning) org key.
  return { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId };
}

async function callTool(name: string, input: Record<string, unknown>, orgId: string, currentPartnerId: string | null) {
  const tool = aiTools.get(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  const raw = await withDbAccessContext(orgKeyContext(orgId, currentPartnerId), () => tool.handler(input, orgKeyAuth(orgId)));
  // What an MCP tools/call caller actually receives.
  return JSON.parse(compactToolResultForChat(name, raw));
}

describe('partner-wide scripts via get_script_details / list_scripts (org key, real RLS)', () => {
  it('shows the own partner-wide script with version and contentSha256, never another partner\'s', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const userA = await createUser({ partnerId: partnerA.id, orgId: orgA.id });
    const userB = await createUser({ partnerId: partnerB.id });
    const suffix = Date.now().toString(36);
    const contentA = '$x = $env:BREEZE_PARAM_MODE\nWrite-Output $x\n';
    const own = await partnerWideScript(partnerA.id, userA.id, `pw-own-${suffix}`, contentA);
    const foreign = await partnerWideScript(partnerB.id, userB.id, `pw-foreign-${suffix}`, 'Write-Output other\n');

    const [head] = await withSystemDbAccessContext(() =>
      db.select().from(scriptVersions).where(eq(scriptVersions.scriptId, own.id)),
    );
    expect(head?.contentDigest).toBe(sha256Content(contentA));

    const details = await callTool('get_script_details', { scriptId: own.id, includeContent: true }, orgA.id, partnerA.id);
    expect(details.error).toBeUndefined();
    expect(details.version).toBe(1);
    expect(details.contentSha256).toBe(sha256Content(contentA));
    expect(details.contentSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(details.content).toBeUndefined();
    expect(details.contentOmitted).toBe(true);

    const other = await callTool('get_script_details', { scriptId: foreign.id }, orgA.id, partnerA.id);
    expect(other.error).toBeTruthy();

    const listed = await callTool('list_scripts', { search: suffix }, orgA.id, partnerA.id);
    const names = (listed.scripts as Array<{ name: string }>).map((s) => s.name);
    expect(names).toContain(`pw-own-${suffix}`);
    expect(names).not.toContain(`pw-foreign-${suffix}`);
  });

  it('run_script expectedContentSha256: a stale pin refuses before any dispatch, a current pin passes the check', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const content = 'Write-Output $env:BREEZE_PARAM_MODE\n';
    const script = await partnerWideScript(partner.id, user.id, `pw-pin-${Date.now().toString(36)}`, content);
    // A device id that does not exist: the pin must be decided before devices are even looked up.
    const deviceIds = ['00000000-0000-4000-8000-000000000001'];

    const stale = await callTool('run_script', { scriptId: script.id, deviceIds, expectedContentSha256: 'a'.repeat(64) }, org.id, partner.id);
    expect(stale).toEqual({ error: 'script_content_mismatch' });

    const current = await callTool('run_script', { scriptId: script.id, deviceIds, expectedContentSha256: sha256Content(content) }, org.id, partner.id);
    expect(JSON.stringify(current)).not.toContain('script_content_mismatch');
    expect(JSON.stringify(current)).not.toContain('Script not found');
  });

  it('without currentPartnerId (the pre-fix org key context) RLS hides the partner-wide row', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const script = await partnerWideScript(partner.id, user.id, `pw-hidden-${Date.now().toString(36)}`, 'Write-Output hi\n');

    const details = await callTool('get_script_details', { scriptId: script.id }, org.id, null);
    expect(details.error).toBeTruthy();
  });
});
