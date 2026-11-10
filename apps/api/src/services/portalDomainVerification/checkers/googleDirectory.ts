/**
 * Portal registration W5 (#11382): proves a customer domain by asking the org's
 * Google Workspace directory (domains.list, DWD scope
 * admin.directory.domain.readonly). Only the directory's own verified domain /
 * domain-alias list counts; the connection's `customer_domain` is never read
 * (it is operator-typed, not proof). Never throws; never logs key or token.
 */
import { hasDbAccessContext, withSystemDbAccessContext } from '../../../db';
import { getDirectoryDomainsClient } from '../../googleClient';
import { captureException } from '../../sentry';
import { googleConnectionBinding } from './googleBinding';
import { decryptConnectionKey, loadGoogleConnection } from '../../googleHelpers';
import type {
  DomainCheckResult,
  DomainCheckTarget,
  DomainCheckUnavailableReason,
  DomainVerificationChecker,
} from '../types';

const GOOGLE_REQUEST_TIMEOUT_MS = 10_000;


interface ErrorShape {
  code?: number | string;
  status?: number;
  message?: string;
  response?: { status?: number; data?: { error?: unknown } };
}

function statusOf(e: ErrorShape): number | undefined {
  return typeof e.code === 'number' ? e.code : (e.status ?? e.response?.status);
}

function mapError(err: unknown): DomainCheckUnavailableReason {
  const e = (err ?? {}) as ErrorShape;
  const message = typeof e.message === 'string' ? e.message : '';
  if (message.includes('unauthorized_client') || e.response?.data?.error === 'unauthorized_client') {
    return 'google_scope_missing';
  }
  const status = statusOf(e);
  if (status === 401 || status === 403) return 'google_access_denied';
  return 'google_unavailable';
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('google_timeout'), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export const googleDirectoryChecker: DomainVerificationChecker = {
  method: 'google_directory',
  async check(target: DomainCheckTarget): Promise<DomainCheckResult> {
    try {
      // A short system-scope read when no context is held (the service runs
      // checks outside any transaction); it closes before the Google call.
      const conn = hasDbAccessContext()
        ? await loadGoogleConnection(target.orgId)
        : await withSystemDbAccessContext(() => loadGoogleConnection(target.orgId), 'portalDomainVerification.loadGoogleConnection');
      if (!conn) return { status: 'fail', reason: 'connection_missing' };

      let key: string;
      try {
        key = decryptConnectionKey(conn);
      } catch {
        // Permanent until the connection is re-saved (e.g. after an encryption
        // key rotation). Report a sanitized error: the original may carry key
        // material. Still `unavailable`: the 7-day stale rule bounds it.
        captureException(new Error('portal domain verification: Google connection key could not be decrypted'));
        console.error(`[portalDomainVerification] google connection key for org ${target.orgId} could not be decrypted`);
        return { status: 'unavailable', reason: 'google_unavailable' };
      }
      const client = getDirectoryDomainsClient(key, conn.adminEmail);
      const res = await withTimeout(
        Promise.resolve(client.domains.list({ customer: 'my_customer' }, { timeout: GOOGLE_REQUEST_TIMEOUT_MS })),
        GOOGLE_REQUEST_TIMEOUT_MS,
      );

      const wanted = target.domain.toLowerCase();
      for (const d of res.data?.domains ?? []) {
        if (d.verified === true && d.domainName?.toLowerCase() === wanted) {
          return { status: 'pass', evidence: { via: 'google_directory', connectionId: conn.id, binding: googleConnectionBinding(conn) } };
        }
        for (const alias of d.domainAliases ?? []) {
          if (alias.verified === true && alias.domainAliasName?.toLowerCase() === wanted) {
            return { status: 'pass', evidence: { via: 'google_directory', connectionId: conn.id, binding: googleConnectionBinding(conn) } };
          }
        }
      }
      return { status: 'fail', reason: 'not_in_directory' };
    } catch (err) {
      const reason = mapError(err);
      // Error code only: never the message, key, token or customer_domain.
      console.warn('[portalDomainVerification] google directory check failed', {
        reason,
        status: statusOf((err ?? {}) as ErrorShape),
      });
      return { status: 'unavailable', reason };
    }
  },
};
