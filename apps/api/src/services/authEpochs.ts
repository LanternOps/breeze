import { eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { users } from '../db/schema';

type Executor = Pick<typeof dbModule.db, 'select'>;

/**
 * Read a user's live auth-state epochs. This is the single source of the
 * `aep`/`mep` claim values for EVERY token-mint path — mint code must never
 * accept caller-provided epochs (a stale/forged epoch would defeat the whole
 * scheme). Pass a `tx` executor to read inside the mutation transaction so the
 * minted token reflects the just-advanced epoch atomically; otherwise the
 * ambient system context is used (mint paths run pre-request-context).
 */
export async function getUserEpochs(
  userId: string,
  executor?: Executor,
): Promise<{ authEpoch: number; mfaEpoch: number } | null> {
  const run = async (db: Executor) => {
    const rows = await db
      .select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    return row ? { authEpoch: row.authEpoch, mfaEpoch: row.mfaEpoch } : null;
  };
  if (executor) return run(executor);
  return dbModule.withSystemDbAccessContext(() => run(dbModule.db));
}
