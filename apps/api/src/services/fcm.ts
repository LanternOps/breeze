import admin from 'firebase-admin';

/**
 * Native Firebase Cloud Messaging (FCM) sender for Android. Mirrors apns.ts's
 * never-throws, structured-result contract so expoPush.ts's dispatcher can
 * treat both native providers identically (#3639).
 */

let firebaseApp: admin.app.App | null = null;

function parseServiceAccount(raw: string): admin.ServiceAccount {
  let parsed: { privateKey?: string; private_key?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  }
  if (parsed.private_key && !parsed.privateKey) {
    parsed.privateKey = parsed.private_key;
  }
  if (typeof parsed.privateKey === 'string') {
    parsed.privateKey = parsed.privateKey.replace(/\\n/g, '\n');
  }
  return parsed as admin.ServiceAccount;
}

/** True iff FIREBASE_SERVICE_ACCOUNT is present. Mirrors isApnsConfigured(). */
export function isFcmConfigured(): boolean {
  return !!process.env.FIREBASE_SERVICE_ACCOUNT;
}

function initFirebase(): admin.app.App {
  if (firebaseApp) return firebaseApp;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  const serviceAccount = parseServiceAccount(raw);
  firebaseApp = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  return firebaseApp;
}

/** Test-only: clears the module-level Firebase app cache. */
export function __resetFcmAppForTests(): void {
  firebaseApp = null;
}

// FCM rejects a `data` payload whose values aren't strings.
function stringifyData(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!data) return out;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined && value !== null) out[key] = String(value);
  }
  return out;
}

// FCM error codes that mean the registration token is permanently dead.
const UNREGISTERED_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export interface FcmPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Store-and-forward window in seconds. */
  ttl?: number;
  /** Android notification channel; must match a channel created client-side. */
  channelId?: string;
  /** Coalesces multiple notifications, mirroring apns-collapse-id. */
  collapseId?: string;
}

export interface FcmResult {
  ok: boolean;
  messageId?: string;
  reason?: string;
  unregistered?: boolean;
}

/**
 * Sends a single notification via FCM. Never throws — returns a structured
 * result, exactly like sendApnsNotification. Returns
 * {ok:false, reason:'not_configured'} when FIREBASE_SERVICE_ACCOUNT is
 * absent, and {unregistered:true} for dead tokens the caller should purge.
 */
export async function sendFcmNotification(token: string, payload: FcmPayload): Promise<FcmResult> {
  if (!isFcmConfigured()) {
    return { ok: false, reason: 'not_configured' };
  }
  try {
    initFirebase();
    const messageId = await admin.messaging().send({
      token,
      notification: { title: payload.title, body: payload.body },
      data: stringifyData(payload.data),
      android: {
        priority: 'high',
        ttl: (payload.ttl ?? 3600) * 1000,
        collapseKey: payload.collapseId,
        notification: payload.channelId ? { channelId: payload.channelId } : undefined,
      },
    });
    return { ok: true, messageId };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code && UNREGISTERED_CODES.has(code)) {
      console.warn('[fcm] token unregistered', { code });
      return { ok: false, reason: code, unregistered: true };
    }
    console.error('[fcm] send failed', { error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: code ?? 'send_error' };
  }
}
