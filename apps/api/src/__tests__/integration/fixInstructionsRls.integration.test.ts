import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { fixInstructions } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const partnerCtx = (partnerId: string): DbAccessContext => ({ scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId], userId: null, currentPartnerId: partnerId });
const orgCtx = (orgId: string, partnerId: string): DbAccessContext => ({ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId });
const row = (partnerId: string) => ({ partnerId, title: 'Clear print queue', steps: ['Stop spooler', 'Delete queue files', 'Start spooler'] });

async function expectSqlState(fn: () => Promise<unknown>, code: string) {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

describe('fix_instructions RLS (partner-axis)', () => {
  it('a partner cannot forge another partner’s reviewed steps (42501)', async () => {
    const a = await createPartner();
    const b = await createPartner();
    await expectSqlState(() => withDbAccessContext(partnerCtx(b.id), () => db.insert(fixInstructions).values(row(a.id))), '42501');
  });

  it('org users read their own partner’s steps but cannot write or see another partner’s', async () => {
    const a = await createPartner();
    const b = await createPartner();
    const orgA = await createOrganization({ partnerId: a.id });
    const [mine] = await withDbAccessContext(SYSTEM, () => db.insert(fixInstructions).values(row(a.id)).returning());
    const [theirs] = await withDbAccessContext(SYSTEM, () => db.insert(fixInstructions).values(row(b.id)).returning());
    await withDbAccessContext(orgCtx(orgA.id, a.id), async () => {
      expect(await db.select().from(fixInstructions).where(eq(fixInstructions.id, mine!.id))).toHaveLength(1);
      expect(await db.select().from(fixInstructions).where(eq(fixInstructions.id, theirs!.id))).toEqual([]);
      expect(await db.update(fixInstructions).set({ title: 'x' }).where(eq(fixInstructions.id, mine!.id)).returning()).toEqual([]);
    });
    await expectSqlState(() => withDbAccessContext(orgCtx(orgA.id, a.id), () => db.insert(fixInstructions).values(row(a.id))), '42501');
  });
});
