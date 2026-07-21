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
 * as L1). Registration now happens silently at login, using the login-minted
 * grant, via {@link ensureApproverDevice} — there is no manual setup step and
 * no PIN. The key activates server-side on its first approval signature
 * (deferred proof-of-possession).
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
  | { status: 'deferred'; reason: 'no_reauth_grant' }
  | { status: 'unsupported'; reason: 'no_hardware' }
  | { status: 'failed'; reason: string };

// Single-flight: RootNavigator's effect can re-fire while a registration is in
// flight (checkAuth double-dispatches setCredentials on cold start). With the
// read-and-clear grant handoff a re-fired effect can never carry the SAME grant
// twice, so the real races are: a grant-less duplicate call resolving `deferred`
// and racing the effect's `active` cleanup to overwrite a real success, and a
// duplicate POST racing the SecureStore write of the credential id. Grant-less
// callers therefore just join whatever attempt is already running. A caller
// that DOES carry a grant is different: dropping it silently strands a fresh,
// unused grant (see below), so it first awaits the in-flight attempt — if that
// attempt already registered the device, the grant is simply left unused
// (harmless, it just expires); otherwise it fires its own attempt with the
// grant, still funnelled through the same single in-flight slot.
let inFlight: Promise<ApproverRegistrationOutcome> | null = null;

/** Run one registration attempt, occupying (and then releasing) `inFlight`. */
function runAttempt(
  signer: HardwareSigner,
  registerGrant: string | undefined,
): Promise<ApproverRegistrationOutcome> {
  inFlight = (async (): Promise<ApproverRegistrationOutcome> => {
    try {
      if (await SecureStore.getItemAsync(CRED_ID_KEY)) {
        return { status: 'already_registered' };
      }
      if (!(await signer.isAvailable())) {
        return { status: 'unsupported', reason: 'no_hardware' };
      }
      if (!registerGrant) {
        return { status: 'deferred', reason: 'no_reauth_grant' };
      }
      const { publicKey } = await signer.createKeys();              // silent, no biometric
      const res = await authedFetch('/api/v1/authenticator/devices', {
        method: 'POST',
        body: JSON.stringify({
          publicKey,
          label: 'This device',
          registerGrantId: registerGrant,
        }),
      });
      if (!res.ok) {
        return { status: 'failed', reason: `http_${res.status}` };
      }
      const { device } = await res.json();
      if (!device?.id) {
        return { status: 'failed', reason: 'missing_device_id' };
      }
      await SecureStore.setItemAsync(CRED_ID_KEY, device.id);
      return { status: 'registered' };
    } catch (e) {
      return { status: 'failed', reason: `exception:${(e as Error)?.name ?? 'unknown'}` };
    }
  })();
  return (async () => {
    try {
      return await inFlight!;
    } finally {
      inFlight = null;
    }
  })();
}

/**
 * Idempotent: ensure this phone has a registered approver key. Called after
 * auth lands. FAILS OPEN — never throws, never blocks login.
 *
 * #2707: registration requires a `register_approver_device` grant minted at
 * login (`authenticatorRegisterGrantId` in the login/mfa-verify response) —
 * proof of a fresh interactive login, independent of the bearer token. With no
 * grant (cold-start restored session) there is nothing to prove with: return
 * `deferred` WITHOUT touching the network; the device registers on the next
 * real login. The ApprovalGate banner (mechanism introduced in #2683) surfaces
 * this state with actionable copy.
 */
export async function ensureApproverDevice(
  signer: HardwareSigner = getHardwareSigner(),
  registerGrant?: string,
): Promise<ApproverRegistrationOutcome> {
  if (inFlight) {
    if (!registerGrant) return inFlight;
    // A grant-bearing call showed up while an attempt (almost certainly
    // grant-less, since grants are read-and-cleared before the attempt even
    // starts) is already running. Wait for it — if it already registered the
    // device, our grant is simply unused and expires harmlessly; otherwise run
    // our own attempt WITH the grant, still through the single in-flight slot.
    const priorOutcome = await inFlight;
    if (priorOutcome.status === 'registered' || priorOutcome.status === 'already_registered') {
      return priorOutcome;
    }
    return runAttempt(signer, registerGrant);
  }
  return runAttempt(signer, registerGrant);
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
