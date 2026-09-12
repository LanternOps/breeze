import './setup';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLogs, portalUsers } from '../../db/schema';
import { hashPassword } from '../../services/password';
import { authRoutes } from '../../routes/portal/auth';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

describe.runIf(!!process.env.DATABASE_URL_APP)('portal authentication audit persistence', () => {
  it('persists attributable success and denial without credential material', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const password = 'Synthetic-Portal-Pass-156!';
    const [user] = await db.insert(portalUsers).values({
      orgId: org.id,
      email: `portal-audit-${Date.now()}@example.test`,
      name: 'Portal Audit Fixture',
      passwordHash: await hashPassword(password),
      status: 'active',
    }).returning();
    if (!user) throw new Error('failed to seed portal user');
    const app = new Hono().route('/', authRoutes);

    const denied = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'synthetic-audit-test' },
      body: JSON.stringify({ email: user.email, password: `${password}-wrong`, orgId: org.id }),
    });
    expect(denied.status).toBe(401);

    const allowed = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'synthetic-audit-test' },
      body: JSON.stringify({ email: user.email, password, orgId: org.id }),
    });
    expect(allowed.status).toBe(200);

    const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, 'portal.auth.login'));
    expect(rows.map((row) => row.result).sort()).toEqual(['denied', 'success']);
    for (const row of rows) {
      expect(row.orgId).toBe(org.id);
      expect(row.actorId).toBe(user.id);
      expect(row.actorEmail).toBe(user.email);
      expect(row.details).toEqual({ httpStatus: row.result === 'success' ? 200 : 401 });
      expect(JSON.stringify(row)).not.toContain(password);
    }
  });
});
