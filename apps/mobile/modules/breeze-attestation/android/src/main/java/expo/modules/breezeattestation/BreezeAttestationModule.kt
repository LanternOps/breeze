package expo.modules.breezeattestation

import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.fragment.app.FragmentActivity
import com.google.android.play.core.integrity.StandardIntegrityManager
import com.google.android.play.core.integrity.IntegrityManagerFactory
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.security.InvalidAlgorithmParameterException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.KeyStoreException
import java.security.NoSuchAlgorithmException
import java.security.NoSuchProviderException
import java.security.ProviderException
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * StrongBox/TEE P-256 approver keys + Android Key Attestation + Play Integrity
 * (#1374, feature #4707 W06). The Android half of the module whose iOS half
 * ships in `ios/BreezeAttestationModule.swift`; both satisfy the one TS surface
 * in `src/BreezeAttestation.types.ts`.
 *
 * The legacy signer (`react-native-biometrics`) mints a biometric-gated RSA
 * key with NO attestation, which the server can only ever record as
 * `unattested` — capping the device at L3. This module is the L4 path: a
 * hardware-backed P-256 key whose certificate chain proves, to Google's root,
 * that the private key was generated inside StrongBox or the TEE and never
 * left it.
 *
 * **What binds what** (getting this wrong is the failure mode this wave
 * exists to close):
 *  - `setAttestationChallenge` receives the RAW BYTES of the KEYGEN digest —
 *    `androidKeyGenChallengeB64` in `src/services/authenticatorTranscript.ts`,
 *    which the server re-derives as `androidKeyGenChallenge`. It is fixed at
 *    key generation, so it CANNOT be the registration transcript (which embeds
 *    the key's own SPKI, not yet in existence).
 *  - the registration transcript is what the new key SIGNS (proof of
 *    possession) and what Play Integrity's `setRequestHash` commits to.
 *  - key identity is tied to the registration server-side, by comparing the
 *    attested leaf key against the registered SPKI.
 *
 * NOT unit-testable in CI — no hardware keystore, no biometric, no Play
 * services on a runner. The same precedent as the Swift half. What CI covers
 * is the JS contract (`attestingSigner.test.ts`,
 * `attestingSigner.android.test.ts`) and the two digest pre-images
 * (`authenticatorTranscript.test.ts`, pinned against the API's own vector).
 * The Kotlin path is verified on physical devices; see the PR's Todd gate.
 */

/** Options for `createAttestedKey`. */
class CreateAttestedKeyOptions : Record {
  /**
   * base64 of the 32-byte KEYGEN challenge. REQUIRED on Android (iOS accepts
   * and ignores it) — `setAttestationChallenge` is a `KeyGenParameterSpec`
   * property, so there is no later point at which it could be supplied.
   */
  @Field
  var attestationChallengeB64: String? = null
}

/**
 * Typed failures. Every one is a refusal — never a degraded success.
 *
 * Extends `CodedException`, NOT a bare `Exception`: `expo.modules.kotlin.Promise`
 * only exposes `reject(CodedException)` and `reject(code, message, cause)` —
 * there is no `reject(Throwable)` overload on it (that one belongs to the
 * unrelated React bridge `Promise`), so a plain `Exception` here would not
 * compile at any `promise.reject(...)` call site in this file. The code is
 * inferred from the class name as `ERR_BREEZE_ATTESTATION`, which is what
 * reaches JS as the rejection code.
 */
class BreezeAttestationException(message: String, cause: Throwable? = null) :
  CodedException(message, cause)

class BreezeAttestationModule : Module() {
  companion object {
    /** One approver key per install. Re-registration replaces it. */
    private const val KEY_ALIAS = "com.breeze.rmm.approver.hw.p256"

    /**
     * Throwaway alias for the availability probe. Distinct from KEY_ALIAS so a
     * probe can never delete, replace, or be mistaken for the real key.
     */
    private const val PROBE_ALIAS = "com.breeze.rmm.approver.hw.p256.probe"

    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
  }

  private val executor: Executor = Executors.newSingleThreadExecutor()

  override fun definition() = ModuleDefinition {
    Name("BreezeAttestation")

    AsyncFunction("isAttestationAvailable") {
      isAttestationAvailable()
    }

    AsyncFunction("createAttestedKey") { options: CreateAttestedKeyOptions? ->
      createAttestedKey(options)
    }

    AsyncFunction("attestApp") { transcriptB64: String, promise: Promise ->
      attestApp(transcriptB64, promise)
    }

    AsyncFunction("signWithAttestedKey") { payloadB64: String, reason: String, promise: Promise ->
      sign(payloadB64, reason, promise)
    }

    AsyncFunction("deleteAttestedKey") {
      deleteKey(KEY_ALIAS)
    }
  }

  // ---------------------------------------------------------------- probe

  /**
   * True when this device can mint an ATTESTED hardware key.
   *
   * Two gates, both load-bearing:
   *  1. API >= 28. `setIsStrongBoxBacked` and a dependable
   *     `setAttestationChallenge` both date from P; below that, attestation
   *     exists but is unreliable enough across OEMs that promising it here
   *     would produce a fleet of `attestation_failed` reports.
   *  2. An actual probe key with an attestation challenge, generated and
   *     immediately deleted. Feature flags lie (several OEMs advertise
   *     `FEATURE_HARDWARE_KEYSTORE` and then hand back a one-element,
   *     self-signed chain); minting one is the only honest answer.
   *
   * Reports FALSE — rather than throwing — for the exceptions that genuinely
   * mean "this hardware cannot attest", so such a device takes the legacy
   * unattested path, which is honest about registering at L2/L3.
   *
   * EVERYTHING ELSE PROPAGATES, on purpose. `approverDevice.runAttempt` has a
   * dedicated fail-closed branch for a probe that throws
   * (`attestation_probe_failed`), because a probe that failed for a reason
   * other than missing hardware means "unknown", not "no" — and answering
   * "no" there would silently register an attestation-capable phone as
   * unattested, which is the exact harm this wave exists to prevent. A blanket
   * `catch (Throwable)` here would make that branch dead code on Android.
   */
  private fun isAttestationAvailable(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
    try {
      deleteKey(PROBE_ALIAS)
      generateKey(
        alias = PROBE_ALIAS,
        challenge = ByteArray(32),
        strongBox = false,
        // The probe must not require user authentication: it would otherwise
        // fail on a phone with no biometric enrolled, and the question being
        // asked is "does attestation work here", not "is a finger enrolled".
        requireUserAuth = false,
      )
      val chain = keyStore().getCertificateChain(PROBE_ALIAS)
      // A genuine attestation chain runs leaf -> intermediates -> Google root.
      // A single self-signed certificate means the platform issued no
      // attestation at all, and the server would reject it.
      return chain != null && chain.size > 1
    } catch (_: UnsupportedOperationException) {
      // The narrow set below is what a platform WITHOUT key attestation
      // actually raises: no EC/AndroidKeyStore provider, an attestation
      // challenge the keymaster rejects, or a keymaster that refuses outright
      // (ProviderException, which StrongBoxUnavailableException extends).
      return false
    } catch (_: NoSuchAlgorithmException) {
      return false
    } catch (_: NoSuchProviderException) {
      return false
    } catch (_: InvalidAlgorithmParameterException) {
      return false
    } catch (_: ProviderException) {
      return false
    } catch (_: KeyStoreException) {
      return false
    } finally {
      // Cleanup must never change the answer, in either direction.
      runCatching { deleteKey(PROBE_ALIAS) }
    }
  }

  // ------------------------------------------------------------ key mint

  /**
   * Mint the hardware key, replacing any previous one, and return its SPKI.
   *
   * StrongBox first, TEE on `StrongBoxUnavailableException`. BOTH outcomes are
   * L4-trusted (`android_strongbox_key_attestation` /
   * `android_tee_key_attestation`) — the fallback is a documented downgrade of
   * the SECURITY LEVEL, not of whether the key is attested, and the server
   * reads which one happened out of the certificate rather than trusting us.
   */
  private fun createAttestedKey(options: CreateAttestedKeyOptions?): Map<String, Any> {
    val challengeB64 = options?.attestationChallengeB64
      ?: throw BreezeAttestationException(
        "attestationChallengeB64 is required on Android: setAttestationChallenge is a " +
          "key-generation parameter and cannot be supplied later",
      )
    val challenge = try {
      Base64.decode(challengeB64, Base64.DEFAULT)
    } catch (e: IllegalArgumentException) {
      throw BreezeAttestationException("attestationChallengeB64 was not valid base64", e)
    }
    // The RAW BYTES go into the certificate — never the base64 TEXT. The server
    // compares the extension against a 32-byte digest, so embedding the 44-char
    // string instead would produce a chain that verifies cryptographically and
    // is then rejected for the wrong challenge, on every phone at once.
    if (challenge.isEmpty()) {
      throw BreezeAttestationException("attestation challenge decoded to zero bytes")
    }

    // Re-registration must not leave the old key behind: the server has already
    // moved to the new public key, and a stale alias would sign for a key the
    // server no longer knows.
    deleteKey(KEY_ALIAS)

    try {
      generateKey(KEY_ALIAS, challenge, strongBox = true, requireUserAuth = true)
    } catch (_: StrongBoxUnavailableException) {
      // DOCUMENTED FALLBACK. Most non-Pixel devices have no StrongBox element;
      // their TEE-backed keys are still hardware-backed and still attested, and
      // the server maps them to `android_tee_key_attestation`, which is L4.
      // Refusing here would deny L4 to the majority of Android devices for no
      // security gain. Deliberately NOT catching anything broader: any other
      // failure is a real failure and must surface.
      deleteKey(KEY_ALIAS)
      generateKey(KEY_ALIAS, challenge, strongBox = false, requireUserAuth = true)
    }

    val cert = keyStore().getCertificate(KEY_ALIAS)
      ?: throw BreezeAttestationException("key generation produced no certificate")
    // Android KeyStore hands back an X.509 SubjectPublicKeyInfo encoding
    // directly, which is exactly what the server parses as SPKI DER — no
    // hand-rolled header needed here (unlike the iOS side, where the Security
    // framework returns a bare X9.62 point).
    val spki = cert.publicKey.encoded
      ?: throw BreezeAttestationException("public key had no X.509 encoding")

    return mapOf(
      "publicKeySpkiB64" to Base64.encodeToString(spki, Base64.NO_WRAP),
      // P-256 + SHA-256, fixed by the KeyGenParameterSpec below. The client's
      // keygen challenge already committed to this value before the key
      // existed, and `approverDevice.ts` asserts the two agree.
      "alg" to "ES256",
    )
  }

  private fun generateKey(
    alias: String,
    challenge: ByteArray,
    strongBox: Boolean,
    requireUserAuth: Boolean,
  ) {
    val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setAttestationChallenge(challenge)

    if (requireUserAuth) {
      // Every signature costs a biometric prompt. Without this the key would
      // sign silently whenever the app is running, and "the technician
      // approved this" would stop being true while still looking true.
      builder.setUserAuthenticationRequired(true)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // Per-use authentication (timeout 0) — an auth-validity window would
        // let one prompt cover later approvals the user never saw.
        builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
      } else {
        @Suppress("DEPRECATION")
        builder.setUserAuthenticationValidityDurationSeconds(-1)
      }
      // Enrolling a new fingerprint or face INVALIDATES this key — the Android
      // counterpart of iOS's `.biometryCurrentSet`. It is the property the
      // server's L4 trust rests on: otherwise an attacker holding an unlocked
      // phone could simply enrol their own biometric and keep the key.
      builder.setInvalidatedByBiometricEnrollment(true)
    }

    if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setIsStrongBoxBacked(true)
    }

    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
      .apply { initialize(builder.build()) }
      .generateKeyPair()
  }

  // ---------------------------------------------------------- attestation

  /**
   * Export the attestation evidence for the key minted above.
   *
   * The certificate chain is the PRIMARY evidence and is what sets the server's
   * basis; Play Integrity is corroborating app-integrity evidence and is
   * optional by design (`playIntegrityToken?` in the shared schema). Play
   * Integrity cannot attest that a key is hardware-backed — only Key
   * Attestation can — so a missing token degrades `appIntegrityVerifiedAt`,
   * never the L4 decision.
   */
  private fun attestApp(transcriptB64: String, promise: Promise) {
    val chain = try {
      keyStore().getCertificateChain(KEY_ALIAS)
    } catch (e: Throwable) {
      promise.reject(BreezeAttestationException("could not read the attestation chain", e))
      return
    }
    if (chain == null || chain.isEmpty()) {
      promise.reject(
        BreezeAttestationException("no attested key on this device — call createAttestedKey first"),
      )
      return
    }
    // `getCertificateChain` returns leaf first, which is the order the server's
    // verifier requires (`certificateChain: string[]`, leaf first, 2..8).
    val chainB64 = chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }

    val requestHash = try {
      requestHashFromTranscript(transcriptB64)
    } catch (e: Throwable) {
      promise.reject(BreezeAttestationException("registration transcript was not valid base64", e))
      return
    }

    requestIntegrityToken(requestHash) { token ->
      val result = mutableMapOf<String, Any>(
        "platform" to "android",
        "certificateChain" to chainB64,
      )
      // Omitted, never faked. An absent token is a schema-legal state the
      // server handles; an invented one would be a forged integrity claim.
      if (token != null) result["playIntegrityToken"] = token
      promise.resolve(result)
    }
  }

  /**
   * The server compares `requestDetails.requestHash` against
   * `transcript.toString('base64url')` — UNPADDED base64url of the 32 raw
   * digest bytes. The JS hands us STANDARD base64, so this decodes and
   * re-encodes rather than passing the string through; the comparison is
   * byte-for-byte on the server and padding alone would fail it.
   */
  private fun requestHashFromTranscript(transcriptB64: String): String {
    val raw = Base64.decode(transcriptB64, Base64.DEFAULT)
    if (raw.isEmpty()) throw IllegalArgumentException("transcript decoded to zero bytes")
    return Base64.encodeToString(raw, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
  }

  /**
   * Standard Play Integrity request. `setCloudProjectNumber` is deliberately
   * omitted: the library derives it for Play-distributed apps, and enterprise
   * / sideloaded builds have no Play services at all — in which case this
   * yields null and the caller ships the chain without a token.
   */
  private fun requestIntegrityToken(requestHash: String, done: (String?) -> Unit) {
    val context = appContext.reactContext?.applicationContext
    if (context == null) {
      done(null)
      return
    }
    if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)) {
      // No Play Integrity on leanback/TV surfaces; skip rather than block the
      // registration on a call that cannot succeed.
      done(null)
      return
    }
    try {
      val manager: StandardIntegrityManager =
        IntegrityManagerFactory.createStandard(context)
      manager
        .prepareIntegrityToken(
          StandardIntegrityManager.PrepareIntegrityTokenRequest.builder().build(),
        )
        .addOnSuccessListener { provider ->
          provider
            .request(
              StandardIntegrityManager.StandardIntegrityTokenRequest.builder()
                // Binds the verdict to THIS registration attempt. The server
                // recomputes the same value from the attempt it minted.
                .setRequestHash(requestHash)
                .build(),
            )
            .addOnSuccessListener { done(it.token()) }
            // A Play Integrity failure must not sink an otherwise valid Key
            // Attestation: the chain alone is what earns L4.
            .addOnFailureListener { done(null) }
        }
        .addOnFailureListener { done(null) }
    } catch (_: Throwable) {
      done(null)
    }
  }

  // -------------------------------------------------------------- signing

  /**
   * Biometric-gated ECDSA-SHA256 over the UTF-8 BYTES OF `payloadB64` AS
   * GIVEN — it is NOT base64-decoded first. The server verifies over the base64
   * STRING as UTF-8 (`verifyMobileSignature` in `apps/api/src/services/
   * mobileHwKey.ts`), so decoding here would produce a signature that never
   * verifies and a 401 nobody could diagnose.
   *
   * A FRESH `Signature`, freshly `initSign`-ed, per call, handed to
   * `BiometricPrompt` inside a `CryptoObject`. A cached authenticated object
   * would let a later approval ride on an earlier prompt the user did see —
   * the same failure the iOS side avoids with a fresh `LAContext`.
   */
  private fun sign(payloadB64: String, reason: String, promise: Promise) {
    val activity = appContext.currentActivity as? FragmentActivity
    if (activity == null) {
      promise.reject(
        BreezeAttestationException("no foreground activity to host the biometric prompt"),
      )
      return
    }

    val entry = try {
      keyStore().getEntry(KEY_ALIAS, null) as? KeyStore.PrivateKeyEntry
    } catch (e: Throwable) {
      promise.reject(BreezeAttestationException("could not load the approver key", e))
      return
    }
    if (entry == null) {
      promise.reject(BreezeAttestationException("no attested approver key on this device"))
      return
    }

    val signature = try {
      Signature.getInstance("SHA256withECDSA").apply { initSign(entry.privateKey) }
    } catch (e: Throwable) {
      // Includes `KeyPermanentlyInvalidatedException` — a new biometric was
      // enrolled and the key is gone. Surfacing it is the point: the caller
      // reports `attestation_failed` and the user re-registers, rather than
      // silently approving at a lower assurance.
      promise.reject(BreezeAttestationException("approver key is unusable: ${e.message}", e))
      return
    }

    val callback = object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationError(code: Int, message: CharSequence) {
        // Cancellation lands here too, and must REJECT. A placeholder signature
        // would be an approval the user declined to give.
        promise.reject(BreezeAttestationException("biometric authentication failed: $message"))
      }

      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        try {
          val sig = result.cryptoObject?.signature
            ?: throw BreezeAttestationException("prompt returned no authenticated signature")
          sig.update(payloadB64.toByteArray(Charsets.UTF_8))
          promise.resolve(
            mapOf("signature" to Base64.encodeToString(sig.sign(), Base64.NO_WRAP)),
          )
        } catch (e: Throwable) {
          promise.reject(BreezeAttestationException("signing failed: ${e.message}", e))
        }
      }
    }

    activity.runOnUiThread {
      try {
        BiometricPrompt(activity, executor, callback).authenticate(
          BiometricPrompt.PromptInfo.Builder()
            .setTitle(reason)
            // BIOMETRIC_STRONG only — the key was generated requiring it, and a
            // device-credential fallback would not satisfy the KeyStore.
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setNegativeButtonText("Cancel")
            .build(),
          BiometricPrompt.CryptoObject(signature),
        )
      } catch (e: Throwable) {
        promise.reject(BreezeAttestationException("could not show the biometric prompt", e))
      }
    }
  }

  // -------------------------------------------------------------- keystore

  private fun keyStore(): KeyStore =
    KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  /**
   * Delete `alias` if it exists. Returns whether an entry was actually
   * removed — `false` means "there was nothing there", NOT "the delete
   * failed". A genuine deletion failure THROWS, because the two are not
   * interchangeable at either call site: `createAttestedKey` must not mint a
   * replacement over a key it could not remove, and `deleteAttestedKey`'s
   * caller must not be told "no key" when one is still sitting in the
   * keystore.
   */
  private fun deleteKey(alias: String): Boolean {
    val ks = keyStore()
    if (!ks.containsAlias(alias)) return false
    ks.deleteEntry(alias)
    return true
  }
}
