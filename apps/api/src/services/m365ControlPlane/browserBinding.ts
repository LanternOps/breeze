import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_TTL_SECONDS = 10 * 60;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Environment = Readonly<Record<string, string | undefined>>;

export type M365ConsentBindingPhase = 'admin_consent' | 'identity_verification';

export interface M365ConsentBrowserBinding {
  phase: M365ConsentBindingPhase;
  rawState: string;
  connectionId: string;
  consentAttemptId: string;
  /**
   * identity_verification: the tenant the identity authority was pinned to, or
   * null for `/organizations` (initial connect / reconnect of an unbound row).
   * admin_consent: the tenant the identity phase cryptographically verified
   * (required).
   */
  tenantId: string | null;
}

interface SignedBinding extends M365ConsentBrowserBinding {
  expiresAt: number;
}

export type M365ConsentBindingInspection =
  | { status: 'valid'; binding: M365ConsentBrowserBinding }
  | { status: 'expired' }
  /**
   * A correctly-signed cookie from the pre-identity-first (v1) flow. Its
   * payload is never decoded or trusted; the only remedy is a restart.
   * Removed in W04 (#7910).
   */
  | { status: 'legacy' }
  | { status: 'invalid' };

function signingKey(source: Environment): string | null {
  return source.APP_ENCRYPTION_KEY?.trim()
    || source.SECRET_ENCRYPTION_KEY?.trim()
    || null;
}

function securitySuffix(source: Environment): string {
  // Microsoft owns the page immediately before the consent callback.  Although
  // a top-level GET normally qualifies for SameSite=Lax, the admin-consent
  // journey can contain a POST/reprocess redirect before that GET.  Chromium
  // may therefore withhold a Lax cookie for the callback, leaving Breeze with
  // a valid database session but no browser binding.  Production is HTTPS-only,
  // so explicitly permit this one path-scoped cookie on the cross-site return.
  return source.NODE_ENV === 'production'
    ? '; SameSite=None; Secure'
    : '; SameSite=Lax';
}

function validBinding(value: unknown): value is SignedBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [
    'connectionId',
    'consentAttemptId',
    'expiresAt',
    'phase',
    'rawState',
    'tenantId',
  ].sort().join(',')) return false;
  if (record.phase !== 'admin_consent' && record.phase !== 'identity_verification') return false;
  if (typeof record.rawState !== 'string' || record.rawState.length < 1 || record.rawState.length > 256) return false;
  if (!UUID.test(String(record.connectionId)) || !UUID.test(String(record.consentAttemptId))) return false;
  if (!Number.isSafeInteger(record.expiresAt)) return false;
  if (record.phase === 'admin_consent') {
    return typeof record.tenantId === 'string' && GUID.test(record.tenantId);
  }
  return record.tenantId === null
    || (typeof record.tenantId === 'string' && GUID.test(record.tenantId));
}

/**
 * Profile-scoped browser-binding configuration. Each M365 consent profile
 * (read, actions, ...) gets its own cookie name, cookie Path, and HMAC
 * context so that:
 *  - a real browser only ever sends the binding cookie back on requests to
 *    that profile's own callback path (Path scoping — a cookie minted at
 *    Path=/api/v1/m365/actions-consent/callback is never sent to
 *    /api/v1/m365/consent/callback, and vice versa), and
 *  - even if a cookie were somehow replayed cross-path (e.g. an attacker
 *    manually forging the header, or a test harness bypassing Path
 *    enforcement), the distinct HMAC context means it fails signature
 *    verification against the other profile's instance.
 */
export interface M365ConsentBindingConfig {
  cookieName: string;
  cookiePath: string;
  hmacContext: string;
  /**
   * HMAC context of the previous cookie format. Used ONLY to recognise a
   * correctly-signed old cookie so the callback can answer `consent_expired`
   * instead of a generic mismatch; such a cookie is never decoded or accepted.
   */
  legacyHmacContext?: string;
}

export interface M365ConsentBindingInstance {
  cookieName: string;
  cookiePath: string;
  buildBindingCookie(binding: M365ConsentBrowserBinding, source?: Environment, now?: Date): string;
  buildClearBindingCookie(source?: Environment): string;
  inspectBindingCookie(cookieHeader: string | undefined, source?: Environment, now?: Date): M365ConsentBindingInspection;
  verifyBindingCookie(cookieHeader: string | undefined, source?: Environment, now?: Date): M365ConsentBrowserBinding | null;
}

export function createM365ConsentBinding(config: M365ConsentBindingConfig): M365ConsentBindingInstance {
  function mac(payload: string, key: string, context: string = config.hmacContext): Buffer {
    return createHmac('sha256', key).update(`${context}.${payload}`).digest();
  }

  function extractCookie(header: string | undefined): string | null {
    if (!header) return null;
    const values: string[] = [];
    for (const item of header.split(';')) {
      const [rawName, ...rest] = item.trim().split('=');
      if (rawName === config.cookieName) values.push(rest.join('='));
    }
    if (values.length !== 1 || !values[0]) return null;
    try {
      return decodeURIComponent(values[0]);
    } catch {
      return null;
    }
  }

  function buildBindingCookie(
    binding: M365ConsentBrowserBinding,
    source: Environment = process.env,
    now: Date = new Date(),
  ): string {
    const key = signingKey(source);
    if (!key) throw new Error('m365_consent_binding_unavailable');
    const signed: SignedBinding = {
      ...binding,
      expiresAt: Math.floor(now.getTime() / 1_000) + COOKIE_TTL_SECONDS,
    };
    if (!validBinding(signed)) throw new Error('m365_consent_binding_invalid');
    const payload = Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url');
    const value = `${payload}.${mac(payload, key).toString('base64url')}`;
    return `${config.cookieName}=${encodeURIComponent(value)}; Path=${config.cookiePath}; HttpOnly${securitySuffix(source)}; Max-Age=${COOKIE_TTL_SECONDS}`;
  }

  function buildClearBindingCookie(source: Environment = process.env): string {
    return `${config.cookieName}=; Path=${config.cookiePath}; HttpOnly${securitySuffix(source)}; Max-Age=0`;
  }

  function inspectBindingCookie(
    cookieHeader: string | undefined,
    source: Environment = process.env,
    now: Date = new Date(),
  ): M365ConsentBindingInspection {
    const key = signingKey(source);
    const encoded = extractCookie(cookieHeader);
    if (!key || !encoded) return { status: 'invalid' };
    const [payload, signature, ...extraParts] = encoded.split('.');
    if (
      !payload
      || !signature
      || extraParts.length > 0
      || !BASE64URL.test(payload)
      || !BASE64URL.test(signature)
    ) {
      return { status: 'invalid' };
    }
    let provided: Buffer;
    try {
      provided = Buffer.from(signature, 'base64url');
    } catch {
      return { status: 'invalid' };
    }
    if (provided.toString('base64url') !== signature) return { status: 'invalid' };
    const expected = mac(payload, key);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      if (config.legacyHmacContext) {
        const legacy = mac(payload, key, config.legacyHmacContext);
        if (provided.length === legacy.length && timingSafeEqual(provided, legacy)) {
          return { status: 'legacy' };
        }
      }
      return { status: 'invalid' };
    }
    let decoded: unknown;
    try {
      const bytes = Buffer.from(payload, 'base64url');
      if (bytes.toString('base64url') !== payload) return { status: 'invalid' };
      decoded = JSON.parse(bytes.toString('utf8'));
    } catch {
      return { status: 'invalid' };
    }
    if (!validBinding(decoded)) return { status: 'invalid' };
    if (decoded.expiresAt <= Math.floor(now.getTime() / 1_000)) return { status: 'expired' };
    const { expiresAt: _expiresAt, ...binding } = decoded;
    return { status: 'valid', binding };
  }

  function verifyBindingCookie(
    cookieHeader: string | undefined,
    source: Environment = process.env,
    now: Date = new Date(),
  ): M365ConsentBrowserBinding | null {
    const inspected = inspectBindingCookie(cookieHeader, source, now);
    return inspected.status === 'valid' ? inspected.binding : null;
  }

  return {
    cookieName: config.cookieName,
    cookiePath: config.cookiePath,
    buildBindingCookie,
    buildClearBindingCookie,
    inspectBindingCookie,
    verifyBindingCookie,
  };
}

// --- customer-graph-read instance (cookie name/path preserved; HMAC context v2 since #7910 W02) ---

const READ_BINDING_CONFIG: M365ConsentBindingConfig = {
  cookieName: 'breeze_m365_graph_read_consent',
  cookiePath: '/api/v1/m365/consent/callback',
  hmacContext: 'breeze:m365-customer-graph-read:browser-binding:v2',
  legacyHmacContext: 'breeze:m365-customer-graph-read:browser-binding:v1',
};

const readBinding = createM365ConsentBinding(READ_BINDING_CONFIG);

export const M365_CONSENT_BINDING_COOKIE_NAME = READ_BINDING_CONFIG.cookieName;
export const M365_CONSENT_CALLBACK_PATH = READ_BINDING_CONFIG.cookiePath;

export function buildM365ConsentBindingCookie(
  binding: M365ConsentBrowserBinding,
  source: Environment = process.env,
  now: Date = new Date(),
): string {
  return readBinding.buildBindingCookie(binding, source, now);
}

export function buildClearM365ConsentBindingCookie(
  source: Environment = process.env,
): string {
  return readBinding.buildClearBindingCookie(source);
}

export function inspectM365ConsentBindingCookie(
  cookieHeader: string | undefined,
  source: Environment = process.env,
  now: Date = new Date(),
): M365ConsentBindingInspection {
  return readBinding.inspectBindingCookie(cookieHeader, source, now);
}

export function verifyM365ConsentBindingCookie(
  cookieHeader: string | undefined,
  source: Environment = process.env,
  now: Date = new Date(),
): M365ConsentBrowserBinding | null {
  return readBinding.verifyBindingCookie(cookieHeader, source, now);
}

// --- customer-graph-actions instance (siblings, distinct cookie/path/HMAC) ---

const ACTIONS_BINDING_CONFIG: M365ConsentBindingConfig = {
  cookieName: 'breeze_m365_graph_actions_consent',
  cookiePath: '/api/v1/m365/actions-consent/callback',
  hmacContext: 'breeze:m365-customer-graph-actions:browser-binding:v2',
  legacyHmacContext: 'breeze:m365-customer-graph-actions:browser-binding:v1',
};

const actionsBinding = createM365ConsentBinding(ACTIONS_BINDING_CONFIG);

export const M365_ACTIONS_CONSENT_BINDING_COOKIE_NAME = ACTIONS_BINDING_CONFIG.cookieName;
export const M365_ACTIONS_CONSENT_CALLBACK_PATH = ACTIONS_BINDING_CONFIG.cookiePath;

export function buildM365ActionsConsentBindingCookie(
  binding: M365ConsentBrowserBinding,
  source: Environment = process.env,
  now: Date = new Date(),
): string {
  return actionsBinding.buildBindingCookie(binding, source, now);
}

export function buildClearM365ActionsConsentBindingCookie(
  source: Environment = process.env,
): string {
  return actionsBinding.buildClearBindingCookie(source);
}

export function inspectM365ActionsConsentBindingCookie(
  cookieHeader: string | undefined,
  source: Environment = process.env,
  now: Date = new Date(),
): M365ConsentBindingInspection {
  return actionsBinding.inspectBindingCookie(cookieHeader, source, now);
}

export function verifyM365ActionsConsentBindingCookie(
  cookieHeader: string | undefined,
  source: Environment = process.env,
  now: Date = new Date(),
): M365ConsentBrowserBinding | null {
  return actionsBinding.verifyBindingCookie(cookieHeader, source, now);
}
