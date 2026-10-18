// Client for the anonymous Trust Center gated-document access flow (API: routes/trustAccessPublic.ts).
// Tokens are only ever sent in POST bodies; they never appear in a path or query string.
import { apiPost, buildPortalApiUrl } from './api';

const OPTS = { redirectOnUnauthorized: false } as const;

export interface RequestAccessInput {
  partnerSlug: string;
  orgSlug: string | null;
  email: string;
  name: string;
  company: string;
  purpose: string;
  ndaAccepted: boolean;
}

export interface AccessGrantDocument { id: string; title: string; category: string; contentType: string; byteSize: number }
export interface AccessGrant { orgName: string; expiresAt: string; documents: AccessGrantDocument[] }

/** A failure worth retrying: rate limited, a server fault, or no response at all. It says nothing about the token. */
export type Transient = 'retry';
const transient = (statusCode: number | undefined) => statusCode === undefined || statusCode === 0 || statusCode === 429 || statusCode >= 500;

/**
 * 'sent' for an accepted request AND for a 404 (the API's 202 never says whether a request was kept, and a 404
 * only says the page does not serve, which the page itself already shows). 'retry' for 429/5xx/network.
 */
export async function requestAccess(input: RequestAccessInput): Promise<'sent' | Transient> {
  try {
    const res = await apiPost('/trust/access/requests', input, OPTS);
    return res.error && transient(res.statusCode) ? 'retry' : 'sent';
  } catch {
    return 'retry';
  }
}

/** The org name, null for an invalid/expired/used link (every such case is the same 404), or 'retry'. */
export async function verifyAccess(token: string): Promise<{ orgName: string } | null | Transient> {
  try {
    const res = await apiPost<{ data?: { orgName?: string } }>('/trust/access/verify', { token }, OPTS);
    const orgName = res.data?.data?.orgName;
    if (!res.error && typeof orgName === 'string') return { orgName };
    return res.error && transient(res.statusCode) ? 'retry' : null;
  } catch {
    return 'retry';
  }
}

export async function fetchGrant(token: string): Promise<AccessGrant | null | Transient> {
  try {
    const res = await apiPost<{ data?: AccessGrant }>('/trust/access/grant', { token }, OPTS);
    const grant = res.data?.data;
    if (!res.error && grant && Array.isArray(grant.documents)) return grant;
    return res.error && transient(res.statusCode) ? 'retry' : null;
  } catch {
    return 'retry';
  }
}

function filenameFrom(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
  if (star) {
    try { return decodeURIComponent(star[1].trim()); } catch { /* fall through */ }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/.exec(disposition) ?? /filename\s*=\s*([^;]+)/.exec(disposition);
  return quoted ? quoted[1].trim() : null;
}

/** Raw binary download (apiPost would JSON-parse). Null on any failure. */
export async function downloadGrantDocument(
  token: string,
  documentId: string,
): Promise<{ blob: Blob; filename: string | null } | null> {
  try {
    const res = await fetch(buildPortalApiUrl('/trust/access/download'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, documentId }),
    });
    if (!res.ok) return null;
    return { blob: await res.blob(), filename: filenameFrom(res.headers.get('content-disposition')) };
  } catch {
    return null;
  }
}
