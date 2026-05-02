import { randomBytes, createHash } from 'node:crypto';
import { db } from '../db';
import { apiKeys } from '../db/schema';

/**
 * Input for `mintApiKey`.
 *
 * Schema note: the existing `api_keys` table scopes keys by `org_id` (FK to
 * `organizations`), not `partner_id`. For partner-level provisioning (e.g. the
 * MCP bootstrap flow) we pin the key to the partner's default organization and
 * rely on the existing MCP auth path (which resolves `partnerId` via
 * `organizations.partnerId`) for partner-scoped reads. `createdBy` is
 * NOT NULL, so callers must pass a real user id — typically the partner's
 * admin user.
 */
export interface MintApiKeyInput {
  partnerId: string;
  defaultOrgId: string;
  createdByUserId: string;
  name: string;
  scopes: string[];
  source: 'mcp_provisioning' | 'manual';
}

export async function mintApiKey(
  input: MintApiKeyInput,
): Promise<{ id: string; rawKey: string }> {
  const rawKey = `brz_${randomBytes(24).toString('hex')}`;
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, 8);

  const [row] = await db
    .insert(apiKeys)
    .values({
      orgId: input.defaultOrgId,
      name: input.name,
      keyHash,
      keyPrefix,
      scopes: input.scopes,
      status: 'active',
      source: input.source,
      createdBy: input.createdByUserId,
    } as any)
    .returning({ id: apiKeys.id });

  if (!row) throw new Error('Failed to insert api_keys row');
  return { id: row.id, rawKey };
}
