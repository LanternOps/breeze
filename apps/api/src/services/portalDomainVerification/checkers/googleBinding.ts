import { createHash } from 'node:crypto';

/**
 * Binds google_directory evidence to the Workspace the connection reaches, not
 * only its row id: the connection upsert (routes/google.ts) replaces the admin
 * and service account in place, keeping the id. A hash, so evidence carries no
 * address. Evidence-at-use (D6) and the worker compare it with the live row.
 */
export function googleConnectionBinding(conn: { adminEmail: string; serviceAccountEmail: string }): string {
  return createHash('sha256')
    .update(`${conn.adminEmail.trim().toLowerCase()}\n${conn.serviceAccountEmail.trim().toLowerCase()}`)
    .digest('hex');
}
