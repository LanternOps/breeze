/**
 * Breeze Authenticator (Phase 3) — mobile hardware-key approver client.
 *
 * Bridges the device's biometric-gated {@link HardwareSigner} to the server
 * approver endpoints. The phone holds a non-exportable RSA key in the Secure
 * Enclave / StrongBox; the server stores only the public key and verifies an
 * RSA-SHA256 signature over a one-time nonce (NOT WebAuthn — a raw signature).
 *
 * All functions are best-effort and FAIL OPEN: a technician with no registered
 * device (or no biometric hardware) simply approves without a proof (recorded
 * as L1). Registration now happens silently at login via
 * {@link ensureApproverDevice} — there is no manual setup step and no PIN. The
 * key activates server-side on its first approval signature (deferred
 * proof-of-possession).
 */
import * as SecureStore from 'expo-secure-store';
import { getServerUrl } from './serverConfig';
import { getHardwareSigner, type HardwareSigner } from './hardwareSigner';
import { getOrCreateInstallationId } from './installationId';

const FALLBACK_API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const TOKEN_KEY = 'breeze_auth_token';
const CRED_ID_KEY = 'breeze_approver_credential_id';

/** The mobile_hw_key proof body the server's approvalProofSchema expects. */
export interface MobileApprovalProof {
  type: 'mobile_hw_key';
  credentialId: string;
  nonce: string;
  signature: string;
}

async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  const deviceId = await getOrCreateInstallationId();
  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-breeze-csrf': '1',
      'X-Breeze-Mobile-Device-Id': deviceId,
      ...(init?.headers ?? {}),
    },
  });
}

/**
 * Outcome of an {@link ensureApproverDevice} attempt.
 *
 * `unsupported` is a normal resting state (simulator, no biometric hardware) and
 * must NOT be surfaced as an error. `failed` means we tried and could not
 * register — the user's approvals will silently stay at L1, so the UI is
 * expected to tell them.
 */
export type ApproverRegistrationOutcome =
  | { status: 'registered' }
  | { status: 'already_registered' }
  | { status: 'unsupported'; reason: 'no_hardware' }
  | { status: 'failed'; reason: string };

/**
 * Idempotent: ensure this phone has a registered approver key. Called after
 * auth lands (fresh login or restored session). FAILS OPEN — any error
 * (no hardware, offline) leaves the device unregistered; it provisions on a
 * later call. The biometric prompt is NOT triggered here (createKeys is
 * silent); the first approval signature is the first prompt and also activates
 * the device server-side.
 *
 * Fail-open is deliberate and unchanged: this never throws and never blocks
 * login. What changed is that it no longer fails *silently* — it reports the
 * outcome so the caller can surface it. The server currently requires a
 * `currentPassword` step-up on this endpoint that the app does not send, so the
 * common failure here is an HTTP 400, which used to be swallowed and left every
 * approval from this phone stuck at L1 with no indication to the user.
 */
export async function ensureApproverDevice(
  signer: HardwareSigner = getHardwareSigner(),
): Promise<ApproverRegistrationOutcome> {
  try {
    if (await SecureStore.getItemAsync(CRED_ID_KEY)) {
      return { status: 'already_registered' };
    }
    if (!(await signer.isAvailable())) {
      return { status: 'unsupported', reason: 'no_hardware' };
    }
    const { publicKey } = await signer.createKeys();                // silent, no biometric
    const res = await authedFetch('/api/v1/authenticator/devices', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'mobile_hw_key',
        publicKey,
        label: 'This device',
        isPlatformBound: true,
      }),
    });
    if (!res.ok) {
      // Still fail open (we retry on a later call) — but say so.
      return { status: 'failed', reason: `http_${res.status}` };
    }
    const { device } = await res.json();
    if (!device?.id) {
      return { status: 'failed', reason: 'missing_device_id' };
    }
    await SecureStore.setItemAsync(CRED_ID_KEY, device.id);
    return { status: 'registered' };
  } catch {
    // fail open — never block login on approver provisioning
    return { status: 'failed', reason: 'exception' };
  }
}

/**
 * Best-effort: produce a hardware-signed proof for an approval decision. Returns
 * null (fall back to an L1 approval) when there is no registered device, no
 * biometric hardware, or the server issues no mobile nonce. A user-cancelled
 * biometric prompt propagates as a throw so the caller can abort rather than
 * silently downgrade a deliberate cancel.
 */
export async function gatherApprovalProof(
  approvalId: string,
  signer: HardwareSigner = getHardwareSigner(),
): Promise<MobileApprovalProof | null> {
  if (!(await signer.isAvailable())) return null;
  const credentialId = await SecureStore.getItemAsync(CRED_ID_KEY);
  if (!credentialId) return null;

  const challengeRes = await authedFetch(`/api/v1/mobile/approvals/${approvalId}/assertion-challenge`, {
    method: 'POST',
  });
  if (!challengeRes.ok) return null;
  const challenge = await challengeRes.json();
  const nonce: string | undefined = challenge?.mobileNonce;
  if (!nonce) return null; // server issued no mobile nonce → device-less path

  const { signature } = await signer.sign(nonce, 'Approve this request');
  return { type: 'mobile_hw_key', credentialId, nonce, signature };
}

/** Whether this device has a locally-recorded approver credential. */
export async function hasRegisteredApprover(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CRED_ID_KEY)) != null;
}
