/**
 * Breeze Authenticator (Phase 3) — mobile hardware-key approver client.
 *
 * Bridges the device's biometric-gated {@link HardwareSigner} to the server
 * approver endpoints. The phone holds a non-exportable RSA key in the Secure
 * Enclave / StrongBox; the server stores only the public key and verifies an
 * RSA-SHA256 signature over a one-time nonce (NOT WebAuthn — a raw signature).
 *
 * All functions are best-effort and FAIL OPEN for the approval path: a
 * technician with no registered device (or no biometric hardware) simply
 * approves without a proof (recorded as L1). Phase 3 is opt-in; enforcement is
 * Phase 4. Registration and PIN-set DO surface errors (they are deliberate
 * setup actions, not the hot approval path).
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
 * Register this device as a mobile_hw_key approver. Generates a hardware
 * keypair, proves possession by signing a server nonce, and persists the
 * server-issued credential id locally for later assertions. Throws on failure
 * (this is an explicit setup action).
 */
export async function registerApproverDevice(
  currentPassword: string,
  label: string,
  signer: HardwareSigner = getHardwareSigner(),
): Promise<{ credentialId: string }> {
  if (!(await signer.isAvailable())) {
    throw new Error('This device has no biometric hardware key available.');
  }
  const { publicKey } = await signer.createKeys();

  // 1. Ask the server for a one-time proof-of-possession nonce (password step-up).
  const optsRes = await authedFetch('/api/v1/authenticator/devices/mobile-hw-key/options', {
    method: 'POST',
    body: JSON.stringify({ currentPassword }),
  });
  if (!optsRes.ok) throw new Error(`Could not start device registration (${optsRes.status}).`);
  const { nonce } = await optsRes.json();

  // 2. Sign the nonce with the freshly minted key (biometric-gated).
  const { signature } = await signer.sign(nonce, 'Register this device for approvals');

  // 3. Submit the public key + PoP signature for verification + storage.
  const verifyRes = await authedFetch('/api/v1/authenticator/devices/mobile-hw-key/verify', {
    method: 'POST',
    body: JSON.stringify({ publicKey, signature, label }),
  });
  if (!verifyRes.ok) throw new Error(`Device registration failed (${verifyRes.status}).`);
  const { device } = await verifyRes.json();
  const credentialId: string = device?.id ?? device?.credentialId;
  if (credentialId) await SecureStore.setItemAsync(CRED_ID_KEY, credentialId);
  return { credentialId };
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

/** Set/replace the approver PIN (password step-up). Throws on failure. */
export async function setApproverPin(currentPassword: string, newPin: string): Promise<void> {
  const res = await authedFetch('/api/v1/auth/pin', {
    method: 'PUT',
    // The server setPinSchema expects `pin` (not `newPin`); the param is named
    // newPin locally for clarity but must serialize to `pin`.
    body: JSON.stringify({ currentPassword, pin: newPin }),
  });
  if (!res.ok) throw new Error(`Could not set PIN (${res.status}).`);
}

/** Verify a PIN for UX feedback (the authoritative check happens at decide time). */
export async function verifyApproverPin(pin: string): Promise<{ verified: boolean; locked: boolean }> {
  const res = await authedFetch('/api/v1/auth/pin/verify', {
    method: 'POST',
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) return { verified: false, locked: false };
  return res.json();
}

/** Whether this device has a locally-recorded approver credential. */
export async function hasRegisteredApprover(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CRED_ID_KEY)) != null;
}
