import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';
import { M365_SYNC_CONTINUATION_MAX_CHARS, type M365SyncActionId } from '@breeze/shared/m365';

/**
 * Opaque, tenant-bound, expiring resume tokens for resumable sync actions
 * (spec §4.1). The API stores the blob and hands it back; it can neither read
 * the Graph skip token nor forge one, and a blob minted for tenant A is
 * unusable against tenant B because the tenant id is authenticated data.
 *
 * The whole @odata.nextLink is sealed rather than the bare skip token: on
 * resume the URL goes back through graphClient's fixedCollectionNextLink
 * host/path guard, which is strictly stronger than re-assembling a URL from a
 * token we would have to trust.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const EXPIRY_BYTES = 4;
const DEFAULT_TTL_SECONDS = 3_600;
const HKDF_SALT = 'breeze-m365-sync-continuation';
const HKDF_INFO = 'v1';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export class SyncContinuationError extends Error {
  readonly code = 'continuation_invalid' as const;

  constructor() {
    super('continuation_invalid');
    this.name = 'SyncContinuationError';
  }
}

export interface SyncContinuationCodec {
  seal(input: { tenantId: string; action: M365SyncActionId; nextLink: string }): string;
  open(input: { tenantId: string; action: M365SyncActionId; continuation: string }): string;
}

function additionalData(tenantId: string, action: M365SyncActionId): Buffer {
  return Buffer.from(`v${VERSION}|${tenantId}|${action}`, 'utf8');
}

export function createSyncContinuationCodec(config: {
  key: Buffer | null;
  ttlSeconds?: number;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}): SyncContinuationCodec {
  const random = config.randomBytes ?? nodeRandomBytes;
  const now = config.now ?? (() => Date.now());
  const ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const secret = config.key ?? random(KEY_BYTES);
  const key = Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO, KEY_BYTES));

  return {
    seal({ tenantId, action, nextLink }) {
      const iv = random(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(additionalData(tenantId, action));
      const expiry = Buffer.alloc(EXPIRY_BYTES);
      expiry.writeUInt32BE(Math.floor(now() / 1_000) + ttlSeconds);
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.concat([expiry, Buffer.from(nextLink, 'utf8')])),
        cipher.final(),
      ]);
      const sealed = Buffer.concat([Buffer.from([VERSION]), iv, ciphertext, cipher.getAuthTag()])
        .toString('base64url');
      if (sealed.length > M365_SYNC_CONTINUATION_MAX_CHARS) throw new SyncContinuationError();
      return sealed;
    },

    open({ tenantId, action, continuation }) {
      if (
        continuation.length === 0
        || continuation.length > M365_SYNC_CONTINUATION_MAX_CHARS
        || !BASE64URL.test(continuation)
      ) throw new SyncContinuationError();
      const bytes = Buffer.from(continuation, 'base64url');
      if (bytes.byteLength <= 1 + IV_BYTES + TAG_BYTES + EXPIRY_BYTES || bytes[0] !== VERSION) {
        throw new SyncContinuationError();
      }
      const iv = bytes.subarray(1, 1 + IV_BYTES);
      const tag = bytes.subarray(bytes.byteLength - TAG_BYTES);
      const ciphertext = bytes.subarray(1 + IV_BYTES, bytes.byteLength - TAG_BYTES);
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(additionalData(tenantId, action));
        decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw new SyncContinuationError();
      }
      if (plaintext.byteLength <= EXPIRY_BYTES) throw new SyncContinuationError();
      if (plaintext.readUInt32BE(0) * 1_000 <= now()) throw new SyncContinuationError();
      return plaintext.subarray(EXPIRY_BYTES).toString('utf8');
    },
  };
}
