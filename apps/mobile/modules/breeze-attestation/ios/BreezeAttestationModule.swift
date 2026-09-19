import DeviceCheck
import ExpoModulesCore
import LocalAuthentication
import Security

/**
 * Secure Enclave P-256 approver keys + Apple App Attest (#1374, feature #4707 W05).
 *
 * The legacy signer (`react-native-biometrics`) mints a biometric-gated Keychain
 * RSA key. That key is NOT in the Secure Enclave — the SE holds P-256 only — so
 * the server can never do better than `unattested` for it, which caps the device
 * at L3. This module is the L4 path: a real Secure Enclave P-256 key, plus an
 * App Attest blob binding the server's registration transcript.
 *
 * NOT unit-testable in CI (no Secure Enclave, no App Attest, in a simulator or
 * on a runner) — the same precedent as `hardwareSigner.ts`. What CI does cover
 * is the JS fallback contract in `attestingSigner.test.ts` and the transcript
 * pre-image in `authenticatorTranscript.test.ts`. The Swift path itself is
 * verified on a physical device; see the Todd gate in this wave's PR.
 */

/** Options for `createAttestedKey`. iOS ignores the challenge (see below). */
struct CreateAttestedKeyOptions: Record {
  /**
   * Android (W06) needs the transcript at key-generation time, because
   * `setAttestationChallenge` is a KeyGenParameterSpec property. iOS does not:
   * App Attest binds the transcript later via `attestKey(_:clientDataHash:)`,
   * so the key is minted before the transcript exists. Accepted and ignored
   * here so both platforms share one call shape.
   */
  @Field var attestationChallengeB64: String? = nil
}

enum BreezeAttestationError: Error, LocalizedError {
  case secureEnclaveUnavailable
  case accessControlFailed(String)
  case keyGenerationFailed(String)
  case noKey
  case publicKeyExportFailed(String)
  case unsupportedKeyEncoding
  case signatureFailed(String)
  case appAttestUnsupported
  case invalidTranscript
  case appAttestFailed(String)

  var errorDescription: String? {
    switch self {
    case .secureEnclaveUnavailable:
      return "Secure Enclave is not available on this device"
    case .accessControlFailed(let detail):
      return "Could not build the key access control: \(detail)"
    case .keyGenerationFailed(let detail):
      return "Secure Enclave key generation failed: \(detail)"
    case .noKey:
      return "No Secure Enclave approver key exists on this device"
    case .publicKeyExportFailed(let detail):
      return "Could not export the public key: \(detail)"
    case .unsupportedKeyEncoding:
      return "Public key was not in the expected X9.62 uncompressed form"
    case .signatureFailed(let detail):
      return "Signing failed or was cancelled: \(detail)"
    case .appAttestUnsupported:
      return "App Attest is not supported on this device"
    case .invalidTranscript:
      return "Registration transcript was not valid base64"
    case .appAttestFailed(let detail):
      return "App Attest failed: \(detail)"
    }
  }
}

/// Keychain label for the SE private key. One approver key per install.
private let keyTag = "com.breeze.rmm.approver.se.p256".data(using: .utf8)!

/**
 * DER prefix for `SubjectPublicKeyInfo { ecPublicKey, prime256v1 }` followed by
 * a 66-byte BIT STRING holding the 65-byte X9.62 uncompressed point.
 *
 * `SecKeyCopyExternalRepresentation` hands back the BARE point (0x04 || X || Y),
 * not an SPKI. The server stores and re-parses this value as SPKI DER
 * (`crypto.createPublicKey({ format: 'der', type: 'spki' })`), so the wrapping
 * has to happen here rather than being asserted about a raw point.
 */
private let p256SpkiHeader: [UInt8] = [
  0x30, 0x59, // SEQUENCE, 89 bytes
  0x30, 0x13, // SEQUENCE, 19 bytes (AlgorithmIdentifier)
  0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID 1.2.840.10045.2.1 ecPublicKey
  0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID 1.2.840.10045.3.1.7 prime256v1
  0x03, 0x42, 0x00 // BIT STRING, 66 bytes, 0 unused bits
]

public class BreezeAttestationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BreezeAttestation")

    AsyncFunction("isAttestationAvailable") { () -> Bool in
      // Both halves must hold: an SE key we cannot mint is as useless as an
      // attestation we cannot produce. Reporting `true` here and failing later
      // is what the fail-closed rule in `attestingSigner.ts` turns into a
      // visible `attestation_failed`, so keep this honest.
      return DCAppAttestService.shared.isSupported && Self.secureEnclaveAvailable()
    }

    AsyncFunction("createAttestedKey") { (options: CreateAttestedKeyOptions?) -> [String: Any] in
      _ = options?.attestationChallengeB64 // iOS binds the transcript at attestApp time.
      let spki = try Self.createKey()
      return ["publicKeySpkiB64": spki, "alg": "ES256"]
    }

    AsyncFunction("attestApp") { (transcriptB64: String, promise: Promise) in
      Self.attest(transcriptB64: transcriptB64, promise: promise)
    }

    AsyncFunction("signWithAttestedKey") { (payloadB64: String, reason: String) -> [String: Any] in
      return ["signature": try Self.sign(payloadB64: payloadB64, reason: reason)]
    }

    AsyncFunction("deleteAttestedKey") { () -> Bool in
      let status = Self.deleteKey()
      return status == errSecSuccess || status == errSecItemNotFound
    }
  }

  // MARK: - Secure Enclave key

  private static func secureEnclaveAvailable() -> Bool {
    // `SecAccessControlCreateWithFlags` only builds a policy object; it does NOT
    // consult the Secure Enclave, the passcode, or biometric enrolment, so on its
    // own it says "yes" on a Simulator and on a passcode-less phone. The key we
    // mint requires `.biometryCurrentSet` under `WhenPasscodeSetThisDeviceOnly`,
    // so the honest probe is whether biometrics can be evaluated right now
    // (which implies a passcode). Reporting `true` here and failing in
    // `createKey` would block the phone from registering at all — the
    // fail-closed rule in `approverDevice.ts` never falls back to legacy.
    let context = LAContext()
    var laError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &laError) else {
      return false
    }
    var error: Unmanaged<CFError>?
    let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
      [.privateKeyUsage, .biometryCurrentSet],
      &error
    )
    return access != nil && error == nil
  }

  /// Mint a fresh SE key, replacing any previous one, and return its SPKI DER.
  private static func createKey() throws -> String {
    guard secureEnclaveAvailable() else { throw BreezeAttestationError.secureEnclaveUnavailable }
    // Re-registration must not leave the old key behind: two keys under one tag
    // makes `SecItemCopyMatching` non-deterministic, and the server has already
    // moved on to the new public key. A delete that neither succeeded nor found
    // nothing is fatal — minting over it would leave two keys, and `sign` could
    // then produce a perfectly valid signature under the key the server
    // discarded, which no error anywhere would explain.
    let deleteStatus = deleteKey()
    guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
      throw BreezeAttestationError.keyGenerationFailed("stale key not removed: OSStatus \(deleteStatus)")
    }

    var accessError: Unmanaged<CFError>?
    guard
      let access = SecAccessControlCreateWithFlags(
        nil,
        // Device-bound and never restored to another device or from a backup.
        kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
        // `.biometryCurrentSet`, NOT `.biometryAny`: enrolling a new face or
        // finger must INVALIDATE this key. That is the property the server's
        // L4 trust rests on, and it is the one thing an attacker with the
        // unlocked device would otherwise be able to add themselves to.
        [.privateKeyUsage, .biometryCurrentSet],
        &accessError
      )
    else {
      let detail = (accessError?.takeRetainedValue()).map { String(describing: $0) } ?? "unknown"
      throw BreezeAttestationError.accessControlFailed(detail)
    }

    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: keyTag,
        kSecAttrAccessControl as String: access,
      ] as [String: Any],
    ]

    var keyError: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &keyError) else {
      let detail = (keyError?.takeRetainedValue()).map { String(describing: $0) } ?? "unknown"
      throw BreezeAttestationError.keyGenerationFailed(detail)
    }
    guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
      throw BreezeAttestationError.publicKeyExportFailed("SecKeyCopyPublicKey returned nil")
    }

    var exportError: Unmanaged<CFError>?
    guard let raw = SecKeyCopyExternalRepresentation(publicKey, &exportError) as Data? else {
      let detail = (exportError?.takeRetainedValue()).map { String(describing: $0) } ?? "unknown"
      throw BreezeAttestationError.publicKeyExportFailed(detail)
    }
    // 0x04 || X(32) || Y(32). Anything else is not the key we asked for, and
    // wrapping it in a P-256 SPKI header would produce a structurally valid DER
    // that decodes to the wrong point.
    guard raw.count == 65, raw.first == 0x04 else {
      throw BreezeAttestationError.unsupportedKeyEncoding
    }
    return (Data(p256SpkiHeader) + raw).base64EncodedString()
  }

  private static func deleteKey() -> OSStatus {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: keyTag,
    ]
    return SecItemDelete(query as CFDictionary)
  }

  // MARK: - Signing

  private static func sign(payloadB64: String, reason: String) throws -> String {
    // The payload is signed AS GIVEN — the UTF-8 bytes of the base64 string, not
    // its decoded bytes. The server verifies over `transcript.toString('base64')`
    // as UTF-8 (`verifyMobileSignature`), so decoding here would produce a
    // signature that never verifies and a 401 nobody could diagnose.
    guard let payload = payloadB64.data(using: .utf8) else {
      throw BreezeAttestationError.signatureFailed("payload was not valid UTF-8")
    }

    // A FRESH LAContext per signature. A cached, already-evaluated context
    // carries a live authentication that the OS will reuse — the biometric
    // prompt would silently not appear, and "the user approved this" would stop
    // being true while still looking true.
    let context = LAContext()
    context.localizedReason = reason

    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecAttrApplicationTag as String: keyTag,
      kSecReturnRef as String: true,
      // The prompt string comes from `context.localizedReason`;
      // `kSecUseOperationPrompt` is deprecated and would compete with it.
      kSecUseAuthenticationContext as String: context,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let cfKey = item else {
      throw status == errSecItemNotFound
        ? BreezeAttestationError.noKey
        : BreezeAttestationError.signatureFailed("keychain status \(status)")
    }
    // swiftlint:disable:next force_cast
    let privateKey = cfKey as! SecKey

    var signError: Unmanaged<CFError>?
    guard
      let signature = SecKeyCreateSignature(
        privateKey,
        // DER-encoded ECDSA over SHA-256 of the message — what Node's
        // `crypto.verify('SHA256', …)` expects for an EC key.
        .ecdsaSignatureMessageX962SHA256,
        payload as CFData,
        &signError
      ) as Data?
    else {
      // Includes user cancellation and a key invalidated by a new biometric
      // enrolment. Never return a placeholder signature — the caller reports
      // `attestation_failed` and the user is told, rather than silently
      // approving at a lower assurance.
      let detail = (signError?.takeRetainedValue()).map { String(describing: $0) } ?? "unknown"
      throw BreezeAttestationError.signatureFailed(detail)
    }
    return signature.base64EncodedString()
  }

  // MARK: - App Attest

  private static func attest(transcriptB64: String, promise: Promise) {
    let service = DCAppAttestService.shared
    guard service.isSupported else {
      promise.reject(BreezeAttestationError.appAttestUnsupported)
      return
    }
    // The platform commits to the RAW digest bytes: `clientDataHash` is the
    // 32-byte transcript, and the server recomputes the App Attest nonce as
    // SHA256(authData || clientDataHash). So this one DOES decode.
    guard let clientDataHash = Data(base64Encoded: transcriptB64) else {
      promise.reject(BreezeAttestationError.invalidTranscript)
      return
    }

    service.generateKey { keyId, error in
      if let error {
        promise.reject(BreezeAttestationError.appAttestFailed(error.localizedDescription))
        return
      }
      guard let keyId else {
        promise.reject(BreezeAttestationError.appAttestFailed("generateKey returned no key id"))
        return
      }
      service.attestKey(keyId, clientDataHash: clientDataHash) { attestation, error in
        if let error {
          promise.reject(BreezeAttestationError.appAttestFailed(error.localizedDescription))
          return
        }
        guard let attestation else {
          promise.reject(BreezeAttestationError.appAttestFailed("attestKey returned no object"))
          return
        }
        promise.resolve([
          "platform": "ios",
          "attestationObject": attestation.base64EncodedString(),
          "keyId": keyId,
        ])
      }
    }
  }
}
