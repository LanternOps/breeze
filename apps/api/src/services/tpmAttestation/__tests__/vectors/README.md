# MakeCredential test vectors (#8318 T1)

`makeCredential.vectors.json` checks the API's TypeScript `MakeCredential`
(`../../makeCredential.ts`) against go-tpm's `tpm2.CreateCredential`, which sizes the
seed to the EK's OAEP digest (32 bytes) as Part 1 rev 1.83 B.10.3 and tpm2-tools
do (2026-10-12 §12.2, review gate). The legacy `credactivation` package uses a
16-byte seed; TPMs accept both, but 32 is the size the spec recommends. Each vector has:

- an EK `TPMT_PUBLIC` in the RSA-2048 default template, plus its PKCS#8 private
  key (a throwaway test key), and the SHA-256 of its SubjectPublicKeyInfo;
- an AK `TPMT_PUBLIC` (restricted RSA signing key) and its name, from go-tpm;
- a fixed 32-byte seed, a secret, and go-tpm's credential blob and encrypted seed.

The blob is compared byte for byte. RSA-OAEP may draw its own randomness, so
the encrypted seed is checked by decrypting it with the EK private key.

Regenerate (new random keys, so the whole file changes):

```bash
cd apps/api/src/services/tpmAttestation/__tests__/vectors/gen
GOTOOLCHAIN=auto go run . > ../makeCredential.vectors.json
```

The generator is its own Go module, pinned to go-tpm v0.9.8; it is not part
of the agent build.
