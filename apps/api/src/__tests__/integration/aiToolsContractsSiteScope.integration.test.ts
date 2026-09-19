/**
 * Integration test — contract site-axis authorization, against real Postgres as
 * the unprivileged `breeze_app` role (#6110).
 *
 * Two distinct guarantees, and they are guarantees at DIFFERENT layers:
 *
 *  1. SCOPE PARITY (the outer door). Every route file under `routes/contracts/`
 *     is `requireScope('partner','system')` (contracts.ts:16, bulk.ts:11,
 *     lines.ts:18, lifecycle.ts:13), so an organization-scoped caller cannot
 *     touch a contract over HTTP. The AI/MCP tools are a second door onto the
 *     SAME services and now require the same scope. Since only
 *     `scope === 'organization'` tokens ever carry `allowedSiteIds`
 *     (middleware/auth.ts:727-734), this door also means a site-restricted
 *     caller never reaches contractService through a tool at all.
 *
 *  2. THE SITE AXIS ITSELF (defence in depth, one layer down). Postgres RLS does
 *     NOT defend the sub-org axis, so contractService enforces it app-layer on
 *     `contract_lines.site_id`. Because (1) closes the only current door onto
 *     it, that rule can only be proven by driving the service directly — which
 *     is exactly what a future fifth door would do. Driven here under
 *     `withDbAccessContext` as `breeze_app`, so the ORG axis is genuinely
 *     enforced by RLS underneath while the site axis is enforced on top.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { contracts, contractLines } from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';
import { getTestDb } from './setup';
import {
  listContracts, getContract, cancelContract, computeContractEstimate,
} from '../../services/contractService';
import { registerContractTools } from '../../services/aiToolsContracts';
import type { ContractActor } from '../../services/contractTypes';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

function contractTool(name: 'list_contracts' | 'get_contract' | 'manage_contracts'): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerContractTools(reg);
  return reg.get(name)!.handler;
}

/** An ORG-scoped, site-restricted AuthContext — the only shape that carries
 *  `allowedSiteIds` in production (middleware/auth.ts:727-734). */
function orgScopedAuth(orgId: string, partnerId: string, allowedSiteIds: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: randomUUID(), email: 'op@example.test', name: 'Op', isPlatformAdmin: false },
    token: {} as never,
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => !!s && allowedSiteIds.includes(s),
  } as unknown as AuthContext;
}

async function seedContract(
  orgId: string, partnerId: string, name: string,
  lines: Array<{ siteId: string | null; siteName: string | null; unitPrice: string }>,
) {
  const [contract] = await getTestDb().insert(contracts).values({
    orgId, partnerId, name, status: 'active', billingTiming: 'advance',
    intervalMonths: 1, startDate: '2026-01-01', currencyCode: 'USD',
  }).returning();
  let sortOrder = 0;
  for (const l of lines) {
    await getTestDb().insert(contractLines).values({
      contractId: contract!.id, orgId,
      // per_device is one of the two SITE_SCOPABLE_LINE_TYPES, so it is the only
      // shape that can carry a site at all.
      lineType: 'per_device', description: `${name} line ${sortOrder}`,
      unitPrice: l.unitPrice, siteId: l.siteId, siteName: l.siteName, sortOrder: sortOrder++,
    });
  }
  return contract!;
}

describe('contract tools + contractService site axis (#6110)', () => {
  it('refuses an ORG-scoped, site-restricted caller at every contract tool', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const allowedSite = await createSite({ orgId: org.id });
    const contract = await seedContract(org.id, partner.id, 'Refused', [
      { siteId: allowedSite.id, siteName: 'Allowed', unitPrice: '10.00' },
    ]);

    const auth = orgScopedAuth(org.id, partner.id, [allowedSite.id]);
    const calls: Array<[Parameters<AiTool['handler']>[0], 'list_contracts' | 'get_contract' | 'manage_contracts']> = [
      [{}, 'list_contracts'],
      [{ contractId: contract.id }, 'get_contract'],
      [{ action: 'cancel', contractId: contract.id }, 'manage_contracts'],
    ];
    for (const [input, name] of calls) {
      const raw = await withDbAccessContext(
        { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
        () => contractTool(name)(input, auth),
      );
      expect(JSON.parse(raw), name).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    }

    // Refused means refused BEFORE the service: the contract is untouched.
    const [after] = await getTestDb().select().from(contracts).where(eq(contracts.id, contract.id));
    expect(after!.status).toBe('active');
  });

  it('narrows, flags and denies correctly for a restricted actor driving the service directly', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const allowedSite = await createSite({ orgId: org.id });
    const hiddenSite = await createSite({ orgId: org.id });

    const visible = await seedContract(org.id, partner.id, 'Visible', [
      { siteId: allowedSite.id, siteName: 'Allowed', unitPrice: '10.00' },
    ]);
    const hiddenOnly = await seedContract(org.id, partner.id, 'HiddenOnly', [
      { siteId: hiddenSite.id, siteName: 'Hidden', unitPrice: '20.00' },
    ]);
    const mixed = await seedContract(org.id, partner.id, 'Mixed', [
      { siteId: allowedSite.id, siteName: 'Allowed', unitPrice: '30.00' },
      { siteId: hiddenSite.id, siteName: 'Hidden', unitPrice: '40.00' },
    ]);

    const restricted: ContractActor = {
      userId: randomUUID(), partnerId: partner.id,
      accessibleOrgIds: [org.id], allowedSiteIds: [allowedSite.id],
    };
    const unrestricted: ContractActor = {
      userId: randomUUID(), partnerId: partner.id, accessibleOrgIds: [org.id],
    };
    const asOrg = <T>(fn: () => Promise<T>) => withDbAccessContext(
      { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] }, fn,
    );

    // ---- list: narrowed in SQL, and the partial one is FLAGGED --------------
    const listed = await asOrg(() => listContracts({ limit: 50 }, restricted));
    expect(listed.map((r) => r.name).sort()).toEqual(['Mixed', 'Visible']);

    const visibleRow = listed.find((r) => r.id === visible.id)!;
    expect(visibleRow.linesFilteredBySiteScope).toBe(false);
    expect(visibleRow.estimatedPeriodValue).not.toBeNull();

    const mixedRow = listed.find((r) => r.id === mixed.id)!;
    expect(mixedRow.linesFilteredBySiteScope).toBe(true);
    // A total summed over only the reachable lines is a DIFFERENT number from
    // the contract's real period value, so it is withheld rather than shown.
    expect(mixedRow.estimatedPeriodValue).toBeNull();

    // ---- get: a fully out-of-site contract is denied ------------------------
    await expect(asOrg(() => getContract(hiddenOnly.id, restricted)))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });

    // ---- get: the mixed one is a PARTIAL read that says so ------------------
    const mixedRead = await asOrg(() => getContract(mixed.id, restricted));
    expect(mixedRead.lines.map((l) => l.siteId)).toEqual([allowedSite.id]);
    expect(mixedRead.linesFilteredBySiteScope).toBe(true);
    expect(mixedRead.periods).toBeNull();

    // ---- whole-document ops on a partially-visible contract are denied ------
    await expect(asOrg(() => computeContractEstimate(mixed.id, restricted)))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });

    // ---- cancel: denied, and the row is genuinely untouched -----------------
    await expect(asOrg(() => cancelContract(hiddenOnly.id, restricted)))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
    await expect(asOrg(() => cancelContract(mixed.id, restricted)))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
    const rows = await getTestDb().select().from(contracts).where(eq(contracts.orgId, org.id));
    expect(rows.every((r) => r.status === 'active')).toBe(true);

    // ---- an unrestricted actor is unaffected --------------------------------
    const all = await asOrg(() => listContracts({ limit: 50 }, unrestricted));
    expect(all.map((r) => r.name).sort()).toEqual(['HiddenOnly', 'Mixed', 'Visible']);
    expect(all.every((r) => r.linesFilteredBySiteScope === undefined)).toBe(true);
    const fullRead = await asOrg(() => getContract(mixed.id, unrestricted));
    expect(fullRead.lines).toHaveLength(2);
    expect(fullRead.periods).toEqual([]);
    expect(fullRead.linesFilteredBySiteScope).toBeUndefined();
    await expect(asOrg(() => cancelContract(hiddenOnly.id, unrestricted))).resolves.toMatchObject({
      status: 'cancelled',
    });
  });

  it('an EMPTY site allowlist reaches no contract at all', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    await seedContract(org.id, partner.id, 'Unreachable', [
      { siteId: site.id, siteName: 'S', unitPrice: '10.00' },
    ]);

    const noSites: ContractActor = {
      userId: randomUUID(), partnerId: partner.id, accessibleOrgIds: [org.id], allowedSiteIds: [],
    };
    const out = await withDbAccessContext(
      { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id] },
      () => listContracts({ limit: 50 }, noSites),
    );
    expect(out).toEqual([]);
  });
});
