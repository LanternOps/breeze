import type { ExtensionSecrets, WorkspaceDatabase } from '../hostTypes';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { workspaceSources } from '../schema/workspace';

const storedCredentialSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  domain: z.string().optional(),
});

type Credential = z.infer<typeof storedCredentialSchema>;
type DecryptedCredential = { username: string; password: string; domain: string | null };

/**
 * A credential row exists but its ciphertext cannot be decrypted, parsed, or
 * shape-validated. Deliberately distinct from "no credential" (null): a wrong
 * key, corrupt ciphertext, or plaintext schema drift must surface as a server
 * error with a log line — never as an indistinguishable 404 while
 * /crawl-config still reports hasCredential: true.
 */
export class CredentialDecryptError extends Error {
  constructor(cause: unknown) {
    super('Workspace credential decrypt failed');
    this.name = 'CredentialDecryptError';
    this.cause = cause;
  }
}

const TABLE = 'workspace_sources';
const COLUMN = 'credential_enc';

export function createCredentialService(
  d: WorkspaceDatabase,
  secrets: ExtensionSecrets,
  // Per-org content flag (W2 Task 3), injected constructor-style. Replaces the
  // process-wide WORKSPACE_CONTENT_PREVIEW env var so decryptForContentIngest
  // can be gated on the calling org's settings, not a global switch.
  getSettings: (orgId: string) => Promise<{ contentEnabled: boolean }>,
) {
  return {
    async set(orgId: string, sourceId: string, cred: Credential): Promise<boolean> {
      const ciphertext = secrets.encryptForColumn(TABLE, COLUMN, JSON.stringify(cred));
      const rows = await d.update(workspaceSources)
        .set({ credentialEnc: ciphertext, updatedAt: new Date() })
        .where(and(
          eq(workspaceSources.orgId, orgId),
          eq(workspaceSources.id, sourceId),
          // Only SMB sources carry credentials; local_profile writes are rejected
          // here so unreachable ciphertext can never be stored.
          eq(workspaceSources.kind, 'smb_share'),
        ))
        .returning({ id: workspaceSources.id });
      return rows.length > 0;
    },

    async clear(orgId: string, sourceId: string): Promise<boolean> {
      const rows = await d.update(workspaceSources)
        .set({ credentialEnc: null, updatedAt: new Date() })
        .where(and(eq(workspaceSources.orgId, orgId), eq(workspaceSources.id, sourceId)))
        .returning({ id: workspaceSources.id });
      return rows.length > 0;
    },

    /**
     * Returns null only for true absence (unknown source, wrong kind, source not
     * assigned to this device, or no credential stored). Decrypt/parse/shape
     * failures throw CredentialDecryptError.
     */
    async decryptForDevice(
      orgId: string,
      sourceId: string,
      deviceId: string,
    ): Promise<DecryptedCredential | null> {
      const [source] = await d.select({
        kind: workspaceSources.kind,
        crawlDeviceId: workspaceSources.crawlDeviceId,
        credentialEnc: workspaceSources.credentialEnc,
      }).from(workspaceSources)
        .where(and(eq(workspaceSources.orgId, orgId), eq(workspaceSources.id, sourceId)))
        .limit(1);

      if (
        !source || source.kind !== 'smb_share' ||
        source.crawlDeviceId !== deviceId || !source.credentialEnc
      ) {
        return null;
      }

      let parsed: Credential;
      try {
        const plaintext = secrets.decryptForColumn(TABLE, COLUMN, source.credentialEnc);
        parsed = storedCredentialSchema.parse(JSON.parse(plaintext));
      } catch (error) {
        throw new CredentialDecryptError(error);
      }
      return { username: parsed.username, password: parsed.password, domain: parsed.domain ?? null };
    },

    /**
     * Org-scoped decrypt for the server-side content-ingest reader
     * (dev-preview). Unlike decryptForDevice this is NOT device-gated — the
     * ingest worker has no device identity — which is a deliberate,
     * preview-only widening of the credential surface:
     *   - hard-disabled unless content is enabled for the org (defense in
     *     depth; the routes that reach here are themselves gated on the same
     *     per-org setting), and
     *   - the bytes this credential unlocks are DLP-inspected at ingest
     *     (extracted text is redacted before store; a 'block' hit persists no
     *     text), but this remains a preview-only widening — never enable in
     *     production.
     * Same null-vs-throw contract as decryptForDevice.
     */
    async decryptForContentIngest(
      orgId: string,
      sourceId: string,
    ): Promise<DecryptedCredential | null> {
      const settings = await getSettings(orgId);
      if (!settings.contentEnabled) {
        throw new Error('content preview disabled');
      }
      const [source] = await d.select({
        kind: workspaceSources.kind,
        credentialEnc: workspaceSources.credentialEnc,
      }).from(workspaceSources)
        .where(and(eq(workspaceSources.orgId, orgId), eq(workspaceSources.id, sourceId)))
        .limit(1);

      if (!source || source.kind !== 'smb_share' || !source.credentialEnc) return null;

      let parsed: Credential;
      try {
        const plaintext = secrets.decryptForColumn(TABLE, COLUMN, source.credentialEnc);
        parsed = storedCredentialSchema.parse(JSON.parse(plaintext));
      } catch (error) {
        throw new CredentialDecryptError(error);
      }
      return { username: parsed.username, password: parsed.password, domain: parsed.domain ?? null };
    },
  };
}
