/**
 * Workstation adapter for the W01 `deliver` port (#6354 W02), mirroring
 * `linkPorts.deliverIfLink`: a short system read of the row's method that
 * FINISHES before any delivery work, then the deliverer (imported lazily to
 * keep the service ↔ ports ↔ deliverer graph acyclic at load time).
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { callerVerifications as v } from '../../db/schema/callerVerification';

export async function deliverIfWorkstation(id: string): Promise<boolean> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db.select({ method: v.method }).from(v).where(eq(v.id, id)).limit(1),
    'callerVerification.workstation.method',
  ));
  if (row?.method !== 'workstation') return false;
  const { deliverWorkstation } = await import('./deliverers/workstation');
  await deliverWorkstation(id);
  return true;
}
