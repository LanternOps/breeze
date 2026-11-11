import type { PSAAlertTicketCreate } from '../psa/types';

/** Persisted input and retry metadata; no runtime/schema dependencies. */
export interface CreateSnapshot {
  input: PSAAlertTicketCreate;
  closeOnResolve: boolean;
  noteOnAcknowledge: boolean;
  closedStatusId: number;
  hourlyCreateCap: number;
  connectionRev?: number;
  connectionUpdatedAt?: string;
  orgId?: string;
  resolvedCompanyCount?: number;
  operationAttempts?: Partial<Record<'create' | 'adopt_lookup' | 'close' | 'note', number>>;
  unknownDeadline?: string;
  duplicateTicketIds?: string[];
  /** Permanent: one human-authorized retry after an uncertain create. */
  createAnywayUsed?: boolean;
}
