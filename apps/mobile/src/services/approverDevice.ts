/**
 * Breeze Authenticator (Phase 3) — mobile hardware-key approver client.
 *
 * Bridges the device's biometric-gated signers to the server approver
 * endpoints. There are TWO registration paths, and which one runs decides the
 * assurance ceiling of every approval this phone ever makes:
 *
 *  - **Attested (#1374 W05/W06).** When `attestingSigner` reports available, the
 *    phone mints a Secure Enclave / StrongBox **P-256** key and registers it
 *    through the two-step challenge/verify protocol, proving both possession of
 *    the key and the integrity of the app. Reaches L4.
 *  - **Legacy, unattested.** Otherwise the single-POST `/devices` route registers
 *    the {@link HardwareSigner}'s biometric-gated Keychain **RSA** key. The server
 *    records it `unattested`, which is honest: nothing vouches for where that key
 *    lives, so it is capped at L2/L3.
 *
 * The choice is one-way. A device that CAN attest and then FAILS must not fall
 * back to the legacy path (`attestation_failed`): silently registering an
 * unattested key would leave the technician believing their phone can approve
 * critical requests when it cannot, with nothing anywhere saying otherwise.
 *
 * All functions are best-effort and FAIL OPEN with respect to LOGIN: a
 * technician with no registered device simply approves without a proof (L1).
 * They never throw and never block sign-in. Registration happens silently at
 * login using the login-minted grant, via {@link ensureApproverDevice}.
 */
import * as SecureStore from 'expo-secure-store';
import { getServerUrl } from './serverConfig';
import { getHardwareSigner, type HardwareSigner } from './hardwareSigner';
import { getOrCreateInstallationId } from './installationId';
import { fetchWithAuthRefresh } from './authedFetch';
import {
  attestationPlatform,
  getAttestingSigner,
  type AttestingSigner,
} from './attestingSigner';
import { androidKeyGenChallengeB64, registrationTranscriptB64 } from './authenticatorTranscript';

const FALLBACK_API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const TOKEN_KEY = 'breeze_auth_token';
const CRED_ID_KEY = 'breeze_approver_credential_id';
/**
 * Set to '1' alongside the credential id when THIS phone registered through the
 * attested path, so approval-time signing picks the matching key.
 *
 * It is not cosmetic bookkeeping. The server verifies an approval assertion with
 * the algorithm stored on the DEVICE ROW (`authenticatorAssurance.ts`, "the
 * algorithm comes from the DEVICE ROW, never from the proof"). An attested row
 * is ES256, so signing that approval with the legacy Keychain RSA key produces a
 * signature that cannot verify — the phone would register at L4 and then fail
 * every proof it ever offered, silently dropping back to L1.
 */
const ATTESTED_KEY = 'breeze_approver_attested';

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
  return fetchWithAuthRefresh(`${baseUrl}${path}`, {
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
  /**
   * `attested` records WHICH path succeeded. It is not cosmetic: an
   * `attested: false` registration can never reach L4, and W07's banner reads
   * this to say so rather than letting the user find out at approval time.
   */
  | { status: 'registered'; attested: true }
  /**
   * `reason: 'attestation_rejected_by_server'` is the one registered-but-not-
   * attested case that is NOT the legacy path: this phone minted a Secure
   * Enclave key and ran App Attest, `/devices/mobile/verify` still 201'd (it
   * always does — a rejected attestation is stored as `unattested`, never
   * refused), and the row it returned says the attestation did not hold. The
   * device signs with the attested key but is capped at L3. Surfaced rather
   * than swallowed so the wrong `appattest-environment` or a stale server is
   * found on the phone, not weeks later at a refused critical approval.
   */
  | {
      status: 'registered';
      attested: false;
      /**
       * `attestation_protocol_absent`: `/devices/mobile/challenge` 404'd, i.e. the
       * server predates the attestation protocol (self-hosted, older than
       * v0.110). That is "attestation unavailable", not "attestation refused",
       * so the phone registered through the legacy path at L2/L3 — the same
       * outcome it had before this app version — rather than failing closed on
       * every sign-in against a server that can never accept an attestation.
       */
      reason?: 'attestation_rejected_by_server' | 'attestation_protocol_absent';
    }
  | { status: 'already_registered' }
  | { status: 'deferred'; reason: 'no_reauth_grant' }
  | { status: 'unsupported'; reason: 'no_hardware' }
  /**
   * `reason: 'attestation_failed'` specifically means the device SUPPORTS
   * attestation and could not complete it — never that it lacks the hardware.
   * `reason: 'attestation_probe_failed'` means the availability probe itself
   * threw, so support was never established either way; both fail closed.
   * Transport-level failures keep their `exception:<Name>` / `http_<status>`
   * reasons, so a dropped connection stays distinguishable from a refusal.
   */
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

const DEVICE_LABEL = 'This device';
const POP_PROMPT = 'Register this phone for approvals';

/**
 * The algorithm the attested keystore always mints (Secure Enclave and the
 * Android P-256 KeyStore path both hold P-256 only). Named as a constant
 * because Android's keygen challenge has to commit to it BEFORE the key exists.
 */
const ATTESTED_KEY_ALG = 'ES256' as const;

/** Thrown inside the attested branch so it can never resolve as a legacy retry. */
/**
 * Thrown by the attested branch when the server has no attestation protocol at
 * all (challenge endpoint 404). The ONE case where falling back to the legacy
 * path is honest: nothing was refused, the capability simply does not exist on
 * that server. Raised before any key is minted or grant consumed.
 */
class AttestationProtocolAbsent extends Error {
  constructor() {
    super('attestation_protocol_absent');
    this.name = 'AttestationProtocolAbsent';
  }
}

class AttestationFailed extends Error {
  constructor(cause: unknown) {
    super(`attestation_failed: ${(cause as Error)?.message ?? 'unknown'}`);
    this.name = 'AttestationFailed';
  }
}

/**
 * Persist the server-issued device id and report success.
 *
 * A 2xx with no device id is a FAILURE, not a success with a missing field:
 * without the id `gatherApprovalProof` can never build a proof, so every later
 * approval would silently drop to L1 with nothing recorded about why.
 *
 * `viaAttestedKey` says which KEY this phone registered with, and drives the
 * signer marker. Whether the registration is *attested* is the SERVER's call:
 * `/devices/mobile/verify` returns 201 for a rejected attestation too (the row
 * is stored with `platformBoundBasis: 'unattested'`), so the outcome reads the
 * basis off the returned device instead of trusting the branch that ran.
 */
async function persistRegistration(
  res: Response,
  viaAttestedKey: boolean,
): Promise<ApproverRegistrationOutcome> {
  if (!res.ok) {
    return { status: 'failed', reason: `http_${res.status}` };
  }
  const { device } = await res.json();
  if (!device?.id) {
    return { status: 'failed', reason: 'missing_device_id' };
  }
  const basis: unknown = device.platformBoundBasis;
  const serverAttested = typeof basis === 'string' && basis !== 'unattested';
  // The marker is written in BOTH directions and BEFORE the credential id.
  // Both directions: a stale `'1'` left behind by an earlier attested enrolment
  // would make `gatherApprovalProof` offer an ES256 signature for an RSA row,
  // i.e. every approval silently rejected. Before the id: if the process dies
  // between the two writes we would rather have a marker with no credential
  // (inert — `gatherApprovalProof` gates on the credential id) than a
  // credential whose signer we then guess wrong.
  if (viaAttestedKey) {
    await SecureStore.setItemAsync(ATTESTED_KEY, '1');
  } else {
    await SecureStore.deleteItemAsync(ATTESTED_KEY);
  }
  await SecureStore.setItemAsync(CRED_ID_KEY, device.id);
  if (viaAttestedKey && !serverAttested) {
    return { status: 'registered', attested: false, reason: 'attestation_rejected_by_server' };
  }
  return viaAttestedKey && serverAttested
    ? { status: 'registered', attested: true }
    : { status: 'registered', attested: false };
}

/**
 * Legacy single-POST registration of the biometric-gated Keychain RSA key.
 * The server records it `unattested`; it works at L2/L3 and can never reach L4.
 * Still the ONLY path on a device with no Secure Enclave / StrongBox, and on
 * Android until W06 lands the Kotlin half of the native module.
 */
async function registerUnattested(
  signer: HardwareSigner,
  registerGrant: string,
): Promise<ApproverRegistrationOutcome> {
  const { publicKey } = await signer.createKeys(); // silent, no biometric
  const res = await authedFetch('/api/v1/authenticator/devices', {
    method: 'POST',
    body: JSON.stringify({
      publicKey,
      label: DEVICE_LABEL,
      registerGrantId: registerGrant,
    }),
  });
  return persistRegistration(res, false);
}

/**
 * Two-step attested registration (#1374 W02 protocol, W05/W06 clients).
 *
 * Every value that matters is the SERVER's: the attempt id and challenge come
 * from /challenge, and the transcript is derived from them plus the key being
 * registered. The phone chooses nothing it then proves.
 *
 * Throws {@link AttestationFailed} for any native-side refusal, so the caller
 * reports `attestation_failed` instead of quietly retrying unattested.
 */
async function registerAttested(
  attesting: AttestingSigner,
  registerGrant: string,
): Promise<ApproverRegistrationOutcome> {
  const platform = attestationPlatform();
  if (!platform) {
    // `isAvailable()` said yes on a runtime that is neither iOS nor Android.
    // Unreachable in practice, and fail-closed if it ever is not: we cannot
    // name a platform the server would bind the attempt to.
    throw new AttestationFailed(new Error('no attestable platform'));
  }

  const challengeRes = await authedFetch('/api/v1/authenticator/devices/mobile/challenge', {
    method: 'POST',
    // The grant is validated NON-consuming here and consumed at /verify, so a
    // failed attestation does not burn it.
    body: JSON.stringify({ platform, registerGrantId: registerGrant }),
  });
  if (challengeRes.status === 404) {
    // The route does not exist on this server: legacy is the only protocol it
    // speaks. Handled in `runAttempt`, which still holds the legacy signer.
    throw new AttestationProtocolAbsent();
  }
  if (!challengeRes.ok) {
    // No key minted yet — nothing to clean up, and nothing was consumed.
    return { status: 'failed', reason: `http_${challengeRes.status}` };
  }
  const { attemptId, challenge } = (await challengeRes.json()) as {
    attemptId?: string;
    challenge?: string;
  };
  if (!attemptId || !challenge) {
    // Hashing `undefined` here would produce a well-formed transcript that
    // could never verify, and a 401 nobody could trace back to this response.
    return { status: 'failed', reason: 'missing_challenge' };
  }

  let key;
  let transcriptB64: string;
  let attestation;
  let popSignature: string;
  try {
    // The challenge is passed at key-generation time for Android, where
    // `setAttestationChallenge` is a KeyGenParameterSpec property and cannot be
    // supplied later. iOS ignores it (App Attest binds the transcript at
    // `attestKey` time).
    //
    // It is NOT the transcript and NOT the raw server challenge. The transcript
    // commits to the key's own SPKI, which does not exist yet; the raw challenge
    // would leave the declared algorithm unbound. So it is a separately
    // domain-tagged digest over (attemptId, challenge, alg) — the exact value
    // `androidKeyGenChallenge` derives server-side and checks against the leaf
    // certificate. Key identity is bound separately, by the server comparing the
    // attested leaf key with the registered SPKI.
    //
    // The algorithm has to be named BEFORE the key exists, so it is asserted
    // against the minted key below rather than assumed.
    const keyGenChallengeB64 = await androidKeyGenChallengeB64({
      attemptId,
      challenge,
      publicKeyAlg: ATTESTED_KEY_ALG,
    });
    key = await attesting.createAttestedKey({ attestationChallengeB64: keyGenChallengeB64 });
    if (key.alg !== ATTESTED_KEY_ALG) {
      // The keygen challenge already committed to ATTESTED_KEY_ALG, so a key of
      // any other algorithm carries a challenge the server will not reproduce.
      // Failing here is a legible client error; continuing would be an opaque
      // attestation rejection at /verify.
      throw new Error(
        `attested key algorithm ${String(key.alg)} does not match the keygen challenge`,
      );
    }
    transcriptB64 = await registrationTranscriptB64({
      attemptId,
      challenge,
      publicKeyAlg: key.alg,
      publicKeySpkiB64: key.publicKeySpkiB64,
    });
    // One digest, two bindings on the client: the platform attestation commits
    // to it, and the new key signs it under a biometric prompt.
    attestation = await attesting.attestApp(transcriptB64);
    ({ signature: popSignature } = await attesting.signPayload(transcriptB64, POP_PROMPT));
  } catch (e) {
    throw new AttestationFailed(e);
  }

  const verifyRes = await authedFetch('/api/v1/authenticator/devices/mobile/verify', {
    method: 'POST',
    body: JSON.stringify({
      registerGrantId: registerGrant,
      attemptId,
      publicKey: key.publicKeySpkiB64,
      publicKeyAlg: key.alg,
      label: DEVICE_LABEL,
      popSignature,
      attestation,
    }),
  });
  // Deliberately NO retry here. The attempt is single-use and already consumed
  // server-side, so replaying `attemptId` can only ever 400 again; the next
  // call mints a fresh attempt.
  return persistRegistration(verifyRes, true);
}

/** Run one registration attempt, occupying (and then releasing) `inFlight`. */
function runAttempt(
  signer: HardwareSigner,
  registerGrant: string | undefined,
  attesting: AttestingSigner,
): Promise<ApproverRegistrationOutcome> {
  inFlight = (async (): Promise<ApproverRegistrationOutcome> => {
    try {
      if (await SecureStore.getItemAsync(CRED_ID_KEY)) {
        return { status: 'already_registered' };
      }
      let canAttest: boolean;
      try {
        canAttest = await attesting.isAvailable();
      } catch {
        // The probe itself failed, so we do NOT know whether this phone can
        // attest. Registering unattested here would be a silent downgrade on a
        // device that may support L4 — the same harm as a failed attestation,
        // so it gets the same fail-closed treatment. A distinct reason keeps
        // "the probe never answered" separable from "attestation was refused"
        // in support triage. RootNavigator reports `failed` outcomes to Sentry
        // with the reason as a tag, so this is visible rather than swallowed.
        return { status: 'failed', reason: 'attestation_probe_failed' };
      }
      // `unsupported` requires BOTH to be absent. A phone with a Secure Enclave
      // but no `react-native-biometrics` build must not report "no hardware".
      if (!canAttest && !(await signer.isAvailable())) {
        return { status: 'unsupported', reason: 'no_hardware' };
      }
      if (!registerGrant) {
        return { status: 'deferred', reason: 'no_reauth_grant' };
      }
      return canAttest
        ? await registerAttested(attesting, registerGrant)
        : await registerUnattested(signer, registerGrant);
    } catch (e) {
      if (e instanceof AttestationProtocolAbsent) {
        const legacy = await registerUnattested(signer, registerGrant!);
        return legacy.status === 'registered'
          ? { status: 'registered', attested: false, reason: 'attestation_protocol_absent' }
          : legacy;
      }
      if (e instanceof AttestationFailed) {
        // Fail CLOSED. Falling through to the legacy path here would register
        // an unattested key on a device the user reasonably believes is
        // hardware-attested, and cap their approvals at L3 with no signal.
        return { status: 'failed', reason: 'attestation_failed' };
      }
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
  attesting: AttestingSigner = getAttestingSigner(),
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
    return runAttempt(signer, registerGrant, attesting);
  }
  return runAttempt(signer, registerGrant, attesting);
}

/**
 * Best-effort: produce a hardware-signed proof for an approval decision. Returns
 * null (fall back to an L1 approval) when there is no registered device, no
 * usable signer, or the server issues no mobile nonce. A user-cancelled
 * biometric prompt propagates as a throw so the caller can abort rather than
 * silently downgrade a deliberate cancel.
 *
 * The signer is chosen by how this device REGISTERED (#1374 W05), because the
 * server verifies with the algorithm on the device row — see {@link ATTESTED_KEY}.
 */
export async function gatherApprovalProof(
  approvalId: string,
  signer: HardwareSigner = getHardwareSigner(),
  attesting: AttestingSigner = getAttestingSigner(),
): Promise<MobileApprovalProof | null> {
  const credentialId = await SecureStore.getItemAsync(CRED_ID_KEY);
  if (!credentialId) return null;

  // WHICH key signs is decided by how this phone registered, not by what
  // happens to be available now. The server verifies with the algorithm stored
  // on the device row, so an attested (ES256) row signed by the legacy RSA key
  // fails verification every time — and it fails as a rejected proof, i.e. an
  // approval that quietly lands at L1.
  const registeredAttested = (await SecureStore.getItemAsync(ATTESTED_KEY)) === '1';
  let sign: (payload: string, reason: string) => Promise<{ signature: string }>;
  if (registeredAttested) {
    // Deliberately NOT falling back to `signer` here. A build or device that can
    // no longer reach the attested key cannot produce a proof this row accepts;
    // offering an RSA signature instead would only turn a clean "no proof" into
    // a verification failure on the server.
    //
    // And deliberately NOT catching the probe: a rejected `isAvailable()` is
    // "unknown", not "no" — the same rule registration applies. Coercing it to
    // `false` here would turn a bridge error into a silent L1 approval from a
    // phone that registered at L4; propagating it aborts the approval loudly,
    // exactly like a cancelled biometric prompt does a few lines down.
    if (!(await attesting.isAvailable())) return null;
    sign = (payload, reason) => attesting.signPayload(payload, reason);
  } else {
    if (!(await signer.isAvailable())) return null;
    sign = (payload, reason) => signer.sign(payload, reason);
  }

  const challengeRes = await authedFetch(`/api/v1/mobile/approvals/${approvalId}/assertion-challenge`, {
    method: 'POST',
  });
  if (!challengeRes.ok) return null;
  const challenge = await challengeRes.json();
  const nonce: string | undefined = challenge?.mobileNonce;
  if (!nonce) return null; // server issued no mobile nonce → device-less path

  // Signed as the UTF-8 bytes of the nonce string, which is what
  // `verifyMobileSignature` hashes. A user-cancelled prompt, or a Secure Enclave
  // key invalidated by a new biometric enrolment, PROPAGATES: the caller aborts
  // rather than silently downgrading a deliberate refusal to an L1 approval.
  const { signature } = await sign(nonce, 'Approve this request');
  return { type: 'mobile_hw_key', credentialId, nonce, signature };
}

/** Whether this device has a locally-recorded approver credential. */
export async function hasRegisteredApprover(): Promise<boolean> {
  return (await SecureStore.getItemAsync(CRED_ID_KEY)) != null;
}
