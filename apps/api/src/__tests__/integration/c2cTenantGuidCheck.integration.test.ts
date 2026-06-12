/**
 * c2c_connections microsoft_365 tenant-GUID CHECK constraint (#1035 item 1, follow-up to #1025)
 *
 * The SSRF-hardening PR (#1025) added a provider-conditional CHECK
 * (`c2c_connections_m365_tenant_guid_chk`, migration
 * 2026-05-31-c2c-tenant-id-guid-check.sql) that rejects a non-GUID `tenant_id`
 * ONLY for `microsoft_365` — NULL is allowed, and other providers
 * (`google_workspace`, …) may legitimately store non-GUID values because the
 * column is shared. Until now only a regex-parity unit test pinned the SQL
 * pattern; nothing proved the constraint actually FIRES. These tests drive each
 * branch against the real test DB.
 *
 * Prerequisites: docker compose -f docker-compose.test.yml up -d
 * Run: pnpm test:integration -- src/__tests__/integration/c2cTenantGuidCheck.integration.test.ts
 */
import './setup';

import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { c2cConnections } from '../../db/schema';

const VALID_GUID = '550e8400-e29b-41d4-a716-446655440000';
const CONSTRAINT = /c2c_connections_m365_tenant_guid_chk/;

describe('c2c_connections microsoft_365 tenant-GUID CHECK (#1035)', () => {
  async function makeOrgId(): Promise<string> {
    const partner = await createPartner({});
    const org = await createOrganization({ partnerId: partner.id });
    return org.id;
  }

  function insertConnection(orgId: string, provider: string, tenantId: string | null) {
    return getTestDb()
      .insert(c2cConnections)
      .values({ orgId, provider, displayName: 'Test connection', tenantId })
      .returning({ id: c2cConnections.id });
  }

  // drizzle wraps the driver error ("Failed query: ...") and keeps the real
  // Postgres message (with the constraint name) on `.cause`.
  async function expectCheckViolation(insert: Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await insert;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const err = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = err?.cause?.message ?? err?.message ?? '';
    expect(message).toMatch(/violates check constraint/i);
    expect(message).toMatch(CONSTRAINT);
  }

  it('rejects a microsoft_365 connection whose tenant_id is not a GUID', async () => {
    const orgId = await makeOrgId();
    await expectCheckViolation(insertConnection(orgId, 'microsoft_365', 'not-a-guid'));
  });

  it('rejects malformed GUIDs for microsoft_365 (too short, non-hex char)', async () => {
    const orgId = await makeOrgId();
    await expectCheckViolation(insertConnection(orgId, 'microsoft_365', '550e8400-e29b-41d4-a716'));
    // trailing 'g' is not a hex digit
    await expectCheckViolation(insertConnection(orgId, 'microsoft_365', '550e8400-e29b-41d4-a716-44665544000g'));
  });

  it('accepts a microsoft_365 connection with a valid GUID, case-insensitively', async () => {
    const orgId = await makeOrgId();
    const lower = await insertConnection(orgId, 'microsoft_365', VALID_GUID);
    expect(lower[0]?.id).toBeTruthy();
    const upper = await insertConnection(orgId, 'microsoft_365', VALID_GUID.toUpperCase());
    expect(upper[0]?.id).toBeTruthy();
  });

  it('accepts a microsoft_365 connection with a NULL tenant_id', async () => {
    const orgId = await makeOrgId();
    const rows = await insertConnection(orgId, 'microsoft_365', null);
    expect(rows[0]?.id).toBeTruthy();
  });

  it('accepts a non-GUID tenant_id for other providers (shared-column safety)', async () => {
    const orgId = await makeOrgId();
    const rows = await insertConnection(orgId, 'google_workspace', 'example.com');
    expect(rows[0]?.id).toBeTruthy();
  });

  it('rejects an UPDATE that flips a microsoft_365 tenant_id to a non-GUID (NOT VALID still enforces mutations)', async () => {
    const orgId = await makeOrgId();
    const rows = await insertConnection(orgId, 'microsoft_365', VALID_GUID);
    const id = rows[0]?.id;
    expect(id).toBeTruthy();
    await expectCheckViolation(
      getTestDb()
        .update(c2cConnections)
        .set({ tenantId: 'not-a-guid' })
        .where(eq(c2cConnections.id, id as string)),
    );
  });
});
