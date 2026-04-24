import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { users } from '../db/schema';

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

export async function findAccount(_ctx: any, sub: string): Promise<any> {
  const row = await asSystem(async () => {
    const [r] = await db.select({
      id: users.id,
      email: users.email,
      name: users.name,
    }).from(users).where(eq(users.id, sub)).limit(1);
    return r ?? null;
  });

  if (!row) return undefined;
  return {
    accountId: row.id,
    async claims(_use: string, _scope: string) {
      // Tenant claims (partner_id/org_id) come from the Grant in extraTokenClaims (provider.ts).
      return {
        sub: row.id,
        email: row.email,
        name: row.name,
      };
    },
  };
}
