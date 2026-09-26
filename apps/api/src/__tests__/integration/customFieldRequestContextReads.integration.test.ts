/**
 * #5199 — the custom-field definition READS run in the CALLER's DB context.
 *
 * `loadVisibleCustomFieldDefinitions` (device PATCH, value import, script
 * write-back) and the definition importer's snapshot used to escalate through
 * the #1105 pattern, `runOutsideDbContext(() => withSystemDbAccessContext(...))`,
 * because an org-scoped session could not see its partner's partner-wide
 * definitions. #4944 (`custom_field_definitions_partner_wide_select`,
 * 2026-10-13-110000) closed that gap in RLS, so the escalation bought nothing
 * but a second pooled connection held under the request's transaction and an
 * RLS bypass whose whole boundary was an app-layer predicate.
 *
 * Each case below runs as `breeze_app` under FORCE RLS and proves one of:
 *
 *  - VISIBILITY: an org token, a device (agent) token and a partner token all
 *    still see their own partner's partner-wide rows through the loader.
 *  - ISOLATION: none of them sees another partner's rows, or a sibling org's.
 *  - SAME CONTEXT (the discriminating cases): a row written earlier in the
 *    SAME request transaction is visible to the read, and an org session
 *    asking for a FOREIGN org's definitions gets nothing. Both are false under
 *    the old escalation (a second connection cannot see an uncommitted row, and
 *    a system context can see every tenant), so these fail if it comes back.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema';
import { loadVisibleCustomFieldDefinitions } from '../../services/customFields/queries';
import {
  previewCustomFieldDefinitionImport,
  type DefinitionImportContext,
} from '../../services/customFields/import/definitionImport';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdKeys: string[] = [];

afterEach(async () => {
  if (createdKeys.length === 0) return;
  const keys = [...new Set(createdKeys)];
  createdKeys.length = 0;
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.delete(customFieldDefinitions).where(inArray(customFieldDefinitions.fieldKey, keys)),
  );
});

/** What `buildDbAccessContext` produces for a user org token. */
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/**
 * What `runWithAgentOrgDbAccess` (routes/agentWs.ts) and `agentAuthMiddleware`
 * build for a device — the script write-back path's context. Same shape as an
 * org token; kept separate so a change to the agent context has one place here.
 */
function agentContext(orgId: string, devicePartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: devicePartnerId,
  };
}

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

function uniqueKey(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

async function seed(values: { orgId?: string; partnerId?: string; fieldKey: string }): Promise<void> {
  createdKeys.push(values.fieldKey);
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(customFieldDefinitions).values({
      name: values.fieldKey,
      type: 'text',
      orgId: values.orgId ?? null,
      partnerId: values.partnerId ?? null,
      fieldKey: values.fieldKey,
    }),
  );
}

/**
 * Two partners, two orgs under the home partner, one under the foreign one,
 * and a definition on every axis.
 */
async function fixture() {
  const home = await createPartner();
  const foreign = await createPartner();
  const org = await createOrganization({ partnerId: home.id });
  const sibling = await createOrganization({ partnerId: home.id });
  const foreignOrg = await createOrganization({ partnerId: foreign.id });
  const keys = {
    own: uniqueKey('own_org'),
    homeWide: uniqueKey('home_wide'),
    sibling: uniqueKey('sibling_org'),
    foreignWide: uniqueKey('foreign_wide'),
    foreignOrg: uniqueKey('foreign_org'),
  };
  await seed({ orgId: org.id, fieldKey: keys.own });
  await seed({ partnerId: home.id, fieldKey: keys.homeWide });
  await seed({ orgId: sibling.id, fieldKey: keys.sibling });
  await seed({ partnerId: foreign.id, fieldKey: keys.foreignWide });
  await seed({ orgId: foreignOrg.id, fieldKey: keys.foreignOrg });
  return { home, foreign, org, sibling, foreignOrg, keys };
}

const fieldKeys = (rows: Array<{ fieldKey: string }>) => rows.map((r) => r.fieldKey).sort();

describe('loadVisibleCustomFieldDefinitions runs in the caller context (#5199)', () => {
  it('org token: sees its own org + its own partner-wide rows, nothing foreign or sibling', async () => {
    const f = await fixture();
    const rows = await withDbAccessContext(orgContext(f.org.id, f.home.id), () =>
      loadVisibleCustomFieldDefinitions(f.org.id),
    );
    expect(fieldKeys(rows)).toEqual([f.keys.own, f.keys.homeWide].sort());
  });

  it('device (agent) token: same visibility as the org token — the script write-back path', async () => {
    const f = await fixture();
    const rows = await withDbAccessContext(agentContext(f.org.id, f.home.id), () =>
      loadVisibleCustomFieldDefinitions(f.org.id),
    );
    expect(fieldKeys(rows)).toEqual([f.keys.own, f.keys.homeWide].sort());
  });

  it('partner token: sees the requested org + its partner-wide rows, never the foreign partner', async () => {
    const f = await fixture();
    const rows = await withDbAccessContext(partnerContext(f.home.id, [f.org.id, f.sibling.id]), () =>
      loadVisibleCustomFieldDefinitions(f.org.id),
    );
    expect(fieldKeys(rows)).toEqual([f.keys.own, f.keys.homeWide].sort());
  });

  it('reads inside the request transaction: a definition written earlier in it is visible', async () => {
    const f = await fixture();
    const fresh = uniqueKey('same_tx');
    createdKeys.push(fresh);

    const rows = await withDbAccessContext(orgContext(f.org.id, f.home.id), async () => {
      // Uncommitted until the context returns. A second pooled connection (the
      // old escalation) cannot see it; the caller's own transaction can.
      await db.insert(customFieldDefinitions).values({
        name: fresh, type: 'text', orgId: f.org.id, partnerId: null, fieldKey: fresh,
      });
      return loadVisibleCustomFieldDefinitions(f.org.id);
    });

    expect(fieldKeys(rows)).toContain(fresh);
  });

  it('RLS is the boundary: an org session naming a FOREIGN org gets nothing back', async () => {
    const f = await fixture();
    const rows = await withDbAccessContext(orgContext(f.org.id, f.home.id), () =>
      loadVisibleCustomFieldDefinitions(f.foreignOrg.id),
    );
    // Under a system context this returned the foreign org's row AND the
    // foreign partner's partner-wide row.
    expect(rows).toEqual([]);
  });
});

describe('definition import snapshot runs in the caller context (#5199)', () => {
  it('org token: preview sees its own partner-wide row and reports the shadow', async () => {
    const f = await fixture();
    const ctx: DefinitionImportContext = {
      partnerId: f.home.id,
      accessibleOrgIds: [f.org.id],
      canManagePartnerWide: false,
    };
    const preview = await withDbAccessContext(orgContext(f.org.id, f.home.id), () =>
      previewCustomFieldDefinitionImport(
        [{ fieldKey: f.keys.homeWide, name: 'x', type: 'text', ownerScope: 'organization', organizationId: f.org.id }],
        ctx,
      ),
    );
    expect(preview[0]!.annotation).toBe('key-shadowed');
  });

  it('partner token: preview sees a definition written earlier in the same request transaction', async () => {
    const f = await fixture();
    const fresh = uniqueKey('same_tx_import');
    createdKeys.push(fresh);
    const ctx: DefinitionImportContext = {
      partnerId: f.home.id,
      accessibleOrgIds: [f.org.id, f.sibling.id],
      canManagePartnerWide: true,
    };

    const preview = await withDbAccessContext(partnerContext(f.home.id, [f.org.id, f.sibling.id]), async () => {
      await db.insert(customFieldDefinitions).values({
        name: fresh, type: 'text', orgId: null, partnerId: f.home.id, fieldKey: fresh,
      });
      return previewCustomFieldDefinitionImport(
        [{ fieldKey: fresh, name: fresh, type: 'text', ownerScope: 'partner' }],
        ctx,
      );
    });

    expect(preview[0]!.annotation).toBe('already-exists');
  });

  it('RLS is the boundary: a context naming a FOREIGN partner resolves none of its orgs or rows', async () => {
    const f = await fixture();
    // A forged import context — the route never builds this (resolveImportPartnerId
    // pins it to the token), which is exactly why only RLS can be asserted here.
    const ctx: DefinitionImportContext = {
      partnerId: f.foreign.id,
      accessibleOrgIds: null,
      canManagePartnerWide: true,
    };
    const preview = await withDbAccessContext(partnerContext(f.home.id, [f.org.id]), () =>
      previewCustomFieldDefinitionImport(
        [
          { fieldKey: f.keys.foreignOrg, name: 'x', type: 'text', ownerScope: 'organization', organizationId: f.foreignOrg.id },
          { fieldKey: f.keys.foreignWide, name: 'x', type: 'text', ownerScope: 'partner' },
        ],
        ctx,
      ),
    );
    expect(preview.map((r) => r.annotation)).toEqual(['org-not-found', 'create']);
  });
});
