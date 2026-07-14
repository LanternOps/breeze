import { createHmac, timingSafeEqual } from 'node:crypto';

export const M365_CONSENT_BINDING_COOKIE_NAME = 'breeze_m365_graph_read_consent';
export const M365_CONSENT_CALLBACK_PATH = '/api/v1/m365/consent/callback';
const COOKIE_TTL_SECONDS = 10 * 60;
const DOMAIN = 'breeze:m365-customer-graph-read:browser-binding:v1';
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
  tenantHint: string | null;
}

interface SignedBinding extends M365ConsentBrowserBinding {
  expiresAt: number;
}

function signingKey(source: Environment): string | null {
  return source.APP_ENCRYPTION_KEY?.trim()
    || source.SECRET_ENCRYPTION_KEY?.trim()
    || null;
}

function securitySuffix(source: Environment): string {
  return `; SameSite=Lax${source.NODE_ENV === 'production' ? '; Secure' : ''}`;
}

function mac(payload: string, key: string): Buffer {
  return createHmac('sha256', key).update(`${DOMAIN}.${payload}`).digest();
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
    'tenantHint',
  ].sort().join(',')) return false;
  if (record.phase !== 'admin_consent' && record.phase !== 'identity_verification') return false;
  if (typeof record.rawState !== 'string' || record.rawState.length < 1 || record.rawState.length > 256) return false;
  if (!UUID.test(String(record.connectionId)) || !UUID.test(String(record.consentAttemptId))) return false;
  if (!Number.isSafeInteger(record.expiresAt)) return false;
  if (record.phase === 'admin_consent') return record.tenantHint === null;
  return typeof record.tenantHint === 'string' && GUID.test(record.tenantHint);
}

function extractCookie(header: string | undefined): string | null {
  if (!header) return null;
  const values: string[] = [];
  for (const item of header.split(';')) {
    const [rawName, ...rest] = item.trim().split('=');
    if (rawName === M365_CONSENT_BINDING_COOKIE_NAME) values.push(rest.join('='));
  }
  if (values.length !== 1 || !values[0]) return null;
  try {
    return decodeURIComponent(values[0]);
  } catch {
    return null;
  }
}

export function buildM365ConsentBindingCookie(
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
  return `${M365_CONSENT_BINDING_COOKIE_NAME}=${encodeURIComponent(value)}; Path=${M365_CONSENT_CALLBACK_PATH}; HttpOnly${securitySuffix(source)}; Max-Age=${COOKIE_TTL_SECONDS}`;
}

export function buildClearM365ConsentBindingCookie(
  source: Environment = process.env,
): string {
  return `${M365_CONSENT_BINDING_COOKIE_NAME}=; Path=${M365_CONSENT_CALLBACK_PATH}; HttpOnly${securitySuffix(source)}; Max-Age=0`;
}

export type M365ConsentBindingInspection =
  | { status: 'valid'; binding: M365ConsentBrowserBinding }
  | { status: 'expired' }
  | { status: 'invalid' };

export function inspectM365ConsentBindingCookie(
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

export function verifyM365ConsentBindingCookie(
  cookieHeader: string | undefined,
  source: Environment = process.env,
  now: Date = new Date(),
): M365ConsentBrowserBinding | null {
  const inspected = inspectM365ConsentBindingCookie(cookieHeader, source, now);
  return inspected.status === 'valid' ? inspected.binding : null;
}
