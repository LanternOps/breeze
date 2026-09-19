/**
 * Apple App Attestation Root CA — the trust anchor for every iOS App Attest
 * attestation this server accepts (#1374, feature #4707 wave W03).
 *
 * Source: https://www.apple.com/certificateauthority/private/
 *         https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 * Subject/Issuer: CN=Apple App Attestation Root CA, O=Apple Inc., ST=California
 * Validity:       2020-03-18 → 2045-03-15
 * SHA-256 (DER):  1CB9823BA28BA6AD2D33A006941DE2AE4F513EF1D4E831B9F7E0FA7B6242C932
 * SHA-256 (.pem): c778d09ac341f7fd9f8f3b19e2b815af6aed4ad4490e1e92c05cb355212a5013
 *
 * A public CA certificate, not infrastructure detail — the CLAUDE.md "no
 * internal infrastructure in public code" rule is about IPs/hostnames/regions.
 *
 * WHY THIS IS A .ts CONSTANT AND NOT A readFileSync OF THE .pem:
 * `apps/api` ships as a single tsup bundle (`dist/index.cjs`) and the runtime
 * images copy only `migrations/`, `assets/` and `ee/workspace/` next to it — no
 * `src/` tree, so a `.pem` beside this file would simply not exist in
 * production and `__dirname` would resolve to `/app/dist`. Inlining the PEM is
 * the only load path that cannot silently break at deploy time.
 *
 * `appleAppAttestRootCA.pem` is still committed alongside as the auditable
 * provenance artifact (it is what you re-download and diff against Apple).
 * `appleAppAttest.test.ts` asserts the two are byte-identical and pins the
 * certificate's SHA-256 fingerprint, so they cannot drift and neither can be
 * swapped for a different CA without a failing test.
 */
export const APPLE_APP_ATTEST_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;
