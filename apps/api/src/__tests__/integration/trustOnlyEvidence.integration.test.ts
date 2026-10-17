import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { m365CaPolicies, m365Connections, m365SyncState } from '../../db/schema';
import { DEFAULT_TRUST_EVALUATION_POLICY, evaluateTrustControls, TRUST_CONTROL_CATALOG } from '@breeze/shared';
import { TRUST_PAGE_EVIDENCE_POLICY } from '../../services/postureEvidence';
import { loadTrustOnlyEvidence } from '../../services/trustPage/trustOnlyEvidence';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const credentialVersion = '0123456789abcdef0123456789abcdef';
const hash = 'a'.repeat(64);

const enforcingConditions = { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] }, clientAppTypes: ['all'] };

async function seedOrg() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const tenantId = randomUUID();
  const [connection] = await db.insert(m365Connections).values({
    orgId: org.id, userId: null, tenantId, consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null,
    profile: 'customer-graph-read', authMode: 'application-certificate', credentialDomain: 'customer-graph-read',
    vaultRef: `akv://vault.example/m365-customer-graph-read-${tenantId}/${credentialVersion}`,
    credentialVersion, permissionManifestVersion: 3, status: 'active',
  }).returning({ id: m365Connections.id });
  const context: DbAccessContext = { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], userId: null as unknown as string };
  return { org, connectionId: connection!.id, context };
}

describe('loadTrustOnlyEvidence (live DB)', () => {
  runDb('two CA policies, one enforcing, fresh sync → mfa_enforced_m365 is met; org-scoped context sees only its own rows', async () => {
    const asOf = new Date();
    const a = await withSystemDbAccessContext(seedOrg);
    const b = await withSystemDbAccessContext(seedOrg);
    await withSystemDbAccessContext(async () => {
      for (const fx of [a, b]) {
        await db.insert(m365SyncState).values({
          orgId: fx.org.id, connectionId: fx.connectionId, domain: 'ca_policies', intervalSeconds: 86400,
          lastCompleteSnapshotAt: new Date(asOf.getTime() - 3_600_000),
        });
      }
      await db.insert(m365CaPolicies).values([
        { orgId: a.org.id, graphId: randomUUID(), coreHash: hash, definitionHash: hash, state: 'enabledForReportingButNotEnforced', conditions: enforcingConditions, grantControls: { operator: 'OR', builtInControls: ['mfa'] } },
        { orgId: a.org.id, graphId: randomUUID(), coreHash: hash, definitionHash: hash, state: 'enabled', conditions: enforcingConditions, grantControls: { operator: 'OR', builtInControls: ['mfa'] } },
        // org B has only a report-only policy: must read not_met, never inherit A's enforcing one.
        { orgId: b.org.id, graphId: randomUUID(), coreHash: hash, definitionHash: hash, state: 'enabledForReportingButNotEnforced', conditions: enforcingConditions, grantControls: { operator: 'OR', builtInControls: ['mfa'] } },
      ]);
    });

    const def = TRUST_CONTROL_CATALOG.filter((d) => d.id === 'mfa_enforced_m365');
    const statusFor = async (fx: typeof a) => {
      const out = await withDbAccessContext(fx.context, () => loadTrustOnlyEvidence(fx.org.id, asOf, TRUST_PAGE_EVIDENCE_POLICY));
      return evaluateTrustControls(def, out as never, DEFAULT_TRUST_EVALUATION_POLICY, asOf)[0]!.status;
    };
    expect(await statusFor(a)).toBe('met');
    expect(await statusFor(b)).toBe('not_met');
  });
});
