import type { Collection } from '../types';

/** Empty instance rows mean not collected yet, not zero interfaces. */
export function portsUp(collection: Collection | null): { up: number; total: number } | null {
  const rows = collection?.oids.find((oid) => oid.baseOid === '1.3.6.1.2.1.2.2.1.8')?.instances;
  if (!rows?.length) return null;
  return { up: rows.filter((row) => row.value === '1').length, total: rows.length };
}
