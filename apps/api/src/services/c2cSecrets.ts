import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { c2cConnections } from '../db/schema';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secretCrypto';

type SecretValue = string | null | undefined;

type C2cSecretFields = {
  clientSecret?: SecretValue;
  refreshToken?: SecretValue;
  accessToken?: SecretValue;
};

type C2cPersistedSecretFields = {
  clientSecret: string | null;
  refreshToken: string | null;
  accessToken: string | null;
};

function encryptOptionalSecret(value: SecretValue): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return encryptSecret(value);
}

function decryptOptionalSecret(value: SecretValue): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return decryptSecret(value);
}

export function encryptC2cConnectionSecrets<T extends C2cSecretFields>(input: T): T {
  return {
    ...input,
    clientSecret: encryptOptionalSecret(input.clientSecret),
    refreshToken: encryptOptionalSecret(input.refreshToken),
    accessToken: encryptOptionalSecret(input.accessToken),
  };
}

export function decryptC2cConnectionSecrets<T extends C2cPersistedSecretFields>(input: T): T {
  return {
    ...input,
    clientSecret: decryptOptionalSecret(input.clientSecret) ?? null,
    refreshToken: decryptOptionalSecret(input.refreshToken) ?? null,
    accessToken: decryptOptionalSecret(input.accessToken) ?? null,
  };
}

export function hasPlaintextC2cConnectionSecrets(input: C2cPersistedSecretFields): boolean {
  return [input.clientSecret, input.refreshToken, input.accessToken].some(
    (value) => typeof value === 'string' && value.length > 0 && !isEncryptedSecret(value)
  );
}

export async function backfillC2cConnectionSecrets(batchSize = 500): Promise<{ scanned: number; updated: number }> {
  let scanned = 0;
  let updated = 0;

  while (true) {
    const rows = await db
      .select({
        id: c2cConnections.id,
        clientSecret: c2cConnections.clientSecret,
        refreshToken: c2cConnections.refreshToken,
        accessToken: c2cConnections.accessToken,
      })
      .from(c2cConnections)
      .where(sql`
        (
          ${c2cConnections.clientSecret} IS NOT NULL
          AND ${c2cConnections.clientSecret} NOT LIKE 'enc:v1:%'
          AND ${c2cConnections.clientSecret} NOT LIKE 'enc:v2:%'
        )
        OR (
          ${c2cConnections.refreshToken} IS NOT NULL
          AND ${c2cConnections.refreshToken} NOT LIKE 'enc:v1:%'
          AND ${c2cConnections.refreshToken} NOT LIKE 'enc:v2:%'
        )
        OR (
          ${c2cConnections.accessToken} IS NOT NULL
          AND ${c2cConnections.accessToken} NOT LIKE 'enc:v1:%'
          AND ${c2cConnections.accessToken} NOT LIKE 'enc:v2:%'
        )
      `)
      .limit(batchSize);

    if (rows.length === 0) {
      break;
    }

    scanned += rows.length;

    for (const row of rows) {
      if (!hasPlaintextC2cConnectionSecrets(row)) {
        continue;
      }

      try {
        const encrypted = encryptC2cConnectionSecrets(row);
        await db
          .update(c2cConnections)
          .set({
            clientSecret: encrypted.clientSecret ?? null,
            refreshToken: encrypted.refreshToken ?? null,
            accessToken: encrypted.accessToken ?? null,
          })
          .where(eq(c2cConnections.id, row.id));

        updated++;
      } catch (err) {
        console.error(`[C2CSecrets] Failed to encrypt secrets for connection ${row.id}:`, err);
      }
    }
  }

  return { scanned, updated };
}
