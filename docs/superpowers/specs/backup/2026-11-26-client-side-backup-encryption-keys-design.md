---
title: Client-side backup encryption keys — browser-generated key pair, passphrase-wrapped private key
status: approved (owner accepted every §11 recommendation on 2026-11-26); advisor quorum done 2026-11-26 (§10); no plan yet
date: 2026-11-26
origin: "#10697 (Create Key always fails). Investigation found nothing consumes storage_encryption_keys and the agent has no client-side encryption; PR #12716 made the Encryption Keys page read-only. Owner direction 2026-11-26: specify option A (key pair generated in the browser, private key wrapped by a passphrase the customer holds, server never receives the plaintext private key)."
related: "#10697, #12716, 2026-03-29-enterprise-backup-phases-design.md §2B, 2026-07-16-incremental-backups-design.md, 2026-09-09-backup-gc-reclamation-design.md, 2026-09-10-bare-metal-boot-media-recovery-design.md, 2026-07-06-bitlocker-filevault-key-escrow-design.md, security tracker CRYPTO4-05"
tracking_issue: (assigned by feature-lifecycle after plan approval)
effort: L (cross-cutting: agent format, API, web, recovery client)
---

# Client-side backup encryption keys

## 1. Problem

The backup Encryption Keys page let an admin "create" a key, but every create failed validation
(#10697), and the failure hid a bigger gap. No code consumes `storage_encryption_keys`. The agent has
no client-side encryption. No document says what `encryptedPrivateKey` is wrapped with, or what
`keyHash` is a hash of. PR #12716 made the page read-only and says so.

Backups today are protected only by the storage provider's own encryption at rest, and only where
the provider can enforce it (S3 SSE-S3 or SSE-KMS). The object keys in the bucket spell out every
backed-up path. Anyone with read access to the bucket can read every file.

This spec defines a key model in which the customer holds the key and Breeze does not. It also
states plainly what that model costs: several flows that run unattended today stop being unattended.

## 2. What the owner decided

| # | Decision | Date |
|---|---|---|
| OD1 | Option A. The key pair is generated in the browser. The private key is wrapped by a passphrase the customer holds, and the server never receives the plaintext private key. | 2026-11-26 |
| OD2 | No code fix to the old form. The page stays read-only until this model ships (PR #12716). | 2026-11-26 |

The owner also accepted every recommendation in §11 on 2026-11-26, so O1 to O11 are decided as recommended there.

## 3. Current state

Verified by reading `origin/main` @ `8c0d746c03` on 2026-11-26. Paths are relative to the repo root.
Lines I did not open myself are marked † and listed in §12.

### 3.1 Key table and routes (metadata only)

- **Schema.** `storage_encryption_keys` is defined at `apps/api/src/db/schema/storageEncryption.ts:4-19`.
  - `org_id` is NOT NULL (`:6`).
  - `key_type` defaults to `aes_256` (`:8`).
  - `public_key_pem` and `encrypted_private_key` are nullable text (`:9-10`). `key_hash` is `varchar(128)` NOT NULL (`:11`).
  - It has no partner column, no unique constraint and no CHECK.
  - It was created in `apps/api/migrations/0075-enterprise-backup-phase2.sql` †. RLS was rewritten to forced shape 1 with `breeze_has_org_access` in `2026-04-11-rewrite-backup-rls-policies.sql:66-86` †.
- **Request schemas.**
  - `createEncryptionKeySchema` (`apps/api/src/routes/backup/schemas.ts:371-377`) requires `encryptedPrivateKey` (16 to 65536 characters) and `keyHash` (16 to 128). It also accepts `keyType: aes_256 | rsa_2048` and an optional `publicKeyPem`.
  - The rotate schema is at `:379-383`.
  - The server never inspects what the material is.
- **Routes** (`apps/api/src/routes/backup/encryption.ts`):
  - Create is at `:42-87` and uses ORGS_WRITE plus MFA.
  - Delete is at `:124-180`. It is a soft delete, and it is refused while any snapshot references the key (`:138-153`).
  - Rotate is at `:184-263`.
  - Create stores the client string **raw** (`:58-69`), although `encryptedColumnRegistry.ts:119` registers the column as server-sealed "backup private key material".
  - `toKeyResponse` returns `managedRestoreSupported: true` whenever the private-key column is non-empty (`:275`). That implies a server-managed restore, which option A forbids.
- **Registrations.**
  - `CORE_ORG_CASCADE_DELETE_ORDER`: `apps/api/src/services/tenantCascade.ts:1036` (list opens at `:262`).
  - Org merge `REPOINT_TABLES`: `apps/api/src/services/orgMergeRegistry.ts:1338` (list opens at `:855`).
  - Export policy: `apps/api/src/services/tenantExportPolicyRegistry.ts:991`, with `encrypted_private_key` and `key_hash` classed `excludedSensitive`.
- **Snapshot link.** `backup_snapshots.encryption_key_id` is a plain FK to the key table (`apps/api/src/db/schema/backup.ts:440`). It is filled from whatever UUID the agent reports in result metadata (`apps/api/src/services/backupResultPersistence.ts:309-324`, written at `:1598`). The FK makes the database reject a key id that does not exist. Nothing checks that the key belongs to the snapshot's org: `resolveSnapshotEncryptionKeyId` only checks that the value looks like a UUID. No agent sets that field today.
- **Prior design text.** `docs/superpowers/specs/backup/2026-03-29-enterprise-backup-phases-design.md:85-89` says only "Agent encrypts with AES-256-GCM before upload; key derived via HKDF with per-snapshot salt from org encryption key". It does not say who holds the org key. Security tracker finding CRYPTO4-05 (`docs/security-reports/security_review_tracker_2026-05-02.md:2788-2820` †) is marked "Fixed / covered" because Wave O made create and rotate require key material. Its recommended next step, "Pick and document the model", was never done. This spec does that.

### 3.2 Agent backup format

- **Layout.** Each snapshot writes one object per file, at `snapshots/<id>/files/<snapshotPath>`, plus `manifest.json` and `layout.json` (`agent/internal/backup/snapshot.go:79-82`).
  - The object key is derived from the source path (`snapshot.go:1233` †). **The bucket sees every directory and file name.**
- **Manifest.** `manifest.json` is plaintext. Each entry carries source path, backup path, size, mtime, mode, owner, attributes and the SHA-256 of the plaintext (`snapshot.go:349-431` †).
- **Deduplication and incrementals.**
  - There is no content deduplication.
  - An incremental run reads the *previous manifest from the bucket* (`agent/internal/backup/incremental.go:56-80`). It builds a path index from it (`:222`) and references an unchanged file's old object by its absolute key (`referenceEntry`, `:306`).
  - Chains are scoped to one device backup identity (`incremental.go:56`, doc comment).
- **Encryption interface.** `providers.Encryptor` (`agent/internal/backup/providers/interfaces.go:44-48`) has no implementations and no callers. A grep of `agent/` finds only its definition.
- **Provider encryption.**
  - Storage-provider encryption is S3 SSE only (`agent/cmd/breeze-backup/exec_backup.go:55-62`; `apps/api/src/services/backupEncryption.ts:70-140` †).
  - A config that requires encryption fails on any provider that cannot enforce SSE (`exec_backup.go:60-62`).
  - The config schema still has `encryption: boolean` (`apps/api/src/routes/backup/schemas.ts:162`).
- **Storage access.** The agent normally gets a short-lived brokered storage session that is bound to one snapshot id (`agent/internal/backup/storagesession/descriptor.go` †). A legacy path still passes raw S3 credentials (`exec_backup.go:139-200` †).

### 3.3 Who reads backup content and manifests

| Reader | Where | Human present? |
|---|---|---|
| **Managed file restore**, same device or another device in the same org | `POST /restore` (`apps/api/src/routes/backup/restore.ts:207`, MFA `:212`). The target is `payload.deviceId ?? snapshot.deviceId` (`:297`) and must be in the same org (`:301`) and online (`:307`). Dispatched as `BACKUP_RESTORE` (`:342`); the helper on the target reads. | Yes (initiator) |
| **VM / Hyper-V / MSSQL restore** | `vmrestore.ts:132,390`, `hyperv.ts:511`, `mssql.ts:526` †. The helper on the target reads. | Yes (initiator) |
| **AI tools** | `restore_snapshot` (`apps/api/src/services/aiToolsBackup.ts:743`) is tier 3, so a human approves; so are the VM / MSSQL / Hyper-V / DR tools †. `browse_snapshots` (`:568`) is tier 1, reads the DB index only, and has no approver. | Approver (restores) |
| **Bare-metal recovery** | Recovery client on boot media. It uses a one-time code at a console (BMR spec). Objects come through `/bmr/recover/download` (`apps/api/src/routes/backup/bmr.ts:1720`). For local destinations the API streams the bytes itself and gunzips them on the fly (`apps/api/src/services/recoveryDownloadService.ts`, `createGunzip`; reached from `bmr.ts:~1929`). | Yes (console) |
| **DR rehearsal** | Mints a recovery token and dispatches `bare_metal_rebuild` to a rebuild host with no console (`apps/api/src/services/drExecutionService.ts:1028-1061`). | **No**, after execute |
| **Post-backup integrity check** | `ensurePostBackupIntegrityChecks` (`apps/api/src/routes/backup/verificationScheduled.ts:651`). The agent downloads every object and checks the plaintext checksum (`agent/internal/backup/verify.go:89`). | **No** |
| **Weekly test restore** | `runWeeklyTestRestore` (`verificationScheduled.ts:691`), then `backup_test_restore` (`verificationService.ts:756`), then the agent's `TestRestoreWithOptions` (`verify.go:400`). | **No** |
| **API server itself** | Reads `manifest.json` from the bucket for file-index hydration (`apps/api/src/services/backupSnapshotFileIndex.ts:137`), attestation verification, reconcile and GC (the GC spec treats manifests as live roots). | n/a |
| **Vault sync** | Reads the manifest to find referenced objects (`agent/internal/backup/vault_manifest.go:32-54` †). | No |

- **File index.** It is `backup_snapshot_files` (path, backup path, size, mtime, kind; `apps/api/src/db/schema/backup.ts:514`). It has two writers:
  - the agent's result (`backupResultPersistence.ts:1807`);
  - server hydration from the bucket manifest.
- **Uses of the file index.** It backs browse, search, selective-restore path resolution and storage-session key authorization.
- **Immutability.** The server applies it, on S3 only (`apps/api/src/services/backupSnapshotStorage.ts:861`). Legal hold is a DB flag that retention honours †.
- **Device org move.** It re-stamps `backup_snapshots` to the destination org (`apps/api/src/routes/devices/core.ts:263`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES`). Backup configs and keys stay with the source org.
- **Browser crypto.** The web app has no WebCrypto use today. CSP `script-src` is `'self'` plus one analytics host in the strict branch, and adds `'unsafe-inline'` only when inline scripts are allowed. Neither branch has `'wasm-unsafe-eval'` (`apps/web/src/middleware.ts:25-27`).

## 4. Goals, non-goals

**Goals**
- Backup content and file names are unreadable to anyone holding only the bucket.
- Backup content is unreadable to anyone holding only the Breeze database and its backups. File names, sizes and mtimes stay in the Breeze file index in v1 (D8.3).
- Unattended backups keep working without any secret on the agent that can decrypt history.
- Every restore path either works with a human-supplied unlock or says plainly that it needs one. No path silently downgrades to plaintext.
- Use standard formats a customer can decrypt without Breeze.

**Non-goals**
- Protecting data against a Breeze server that is compromised *while it runs* (§6, D9).
- Hiding file names from the Breeze server in v1 (D8.3 offers it later).
- Client-side encryption for cloud-to-cloud (M365) backup. That runs server-side and is a scaffold today (`apps/api/src/jobs/c2cBackupWorker.ts:6` †).
- Re-encrypting existing plaintext snapshots.
- Writing the implementation plan. That follows approval of this spec.

**Anti-goals**
- A server-held decryption key "for convenience". That is option C/D of the investigation, and the owner declined it.
- An agent-held symmetric master key (the restic and kopia model). Every enrolled agent would then carry a key that decrypts the org's whole history.

## 5. The model in one page

Three key layers, each a named standard construction:

```
 L2  Org identity (one per org key version)        generated in the BROWSER
     age identity, hybrid ML-KEM-768 + X25519       private part: age scrypt passphrase file
     public recipient → agents                      → stored on server (also server-sealed)
          │ age-encrypts                            → downloadable "recovery kit"
          ▼
 L1  Run data key (DEK), 256-bit random            generated by the AGENT per backup run
     envelope = age file to the org RECIPIENT SET   stored in DB + bucket
                                                    (snapshots/<originSnapshotId>/keys/<keyId>.age)
     content manifest = age file to the same SET    (paths, object ids, key ids)
          │ keys
          ▼
 L0  Objects: Tink streaming AEAD                   written by the AGENT
     AES256_GCM_HKDF_1MB, AAD binds origin          file contents, content manifest,
     snapshot + object id + role                    system-state artifacts
```

- **Backup.** The agent holds only public recipients. It makes a fresh DEK for the run, uploads the DEK's envelope first, encrypts every new object under the DEK, and then forgets the DEK.
- **Restore.** A human unlocks the org identity *in the browser* with the passphrase. The browser opens the snapshot's content manifest and only the DEK envelopes it names, and age-encrypts those DEKs (plus the selected manifest entries) to a one-job ephemeral recipient generated by the helper that performs the restore. On every online path the org identity never leaves the browser. The one exception is the BMR offline fallback (D3), where the recovery client decrypts the identity on the recovery machine.
- **Recovery.** A second customer-held recovery identity is a recipient on every DEK envelope. If the passphrase is lost, the recovery identity still opens the backups. If both are lost, the data is gone.

## 6. Decisions

Each decision lists options, consequences and a recommendation (**Rec**).

### D1. What is encrypted with what

**D1.1 Granularity of data keys**

| Option | Consequence |
|---|---|
| (a) One org master symmetric key, held by agents (restic model) | Simplest. But every agent can decrypt all history, the anti-goal in §4. |
| (b) A random key per object, each wrapped to the org public key | One public-key operation and about 1.1 KB of hybrid KEM ciphertext per object. A restore needs either the org private key on the agent or millions of releases. |
| (c) **A random DEK per backup run, wrapped to the org recipients; per-object subkeys derived inside the AEAD** | One public-key operation per run. A restore releases a small set of DEKs, one per run that wrote an object the restore needs. The agent never needs the private key. |

**Rec (c).** A "run" means one write session of one snapshot. A crash or resume that loses the
in-memory DEK starts a new DEK with a new key id. A snapshot can therefore reference several key
ids, which incrementals already require.

**D1.2 Algorithms (all standard, with named libraries)**

- **L0, objects.**
  - **Construction.** Tink streaming AEAD `AES256_GCM_HKDF_1MB`: AES-256-GCM in 1 MiB segments. A per-ciphertext random salt feeds HKDF-SHA256 to derive the segment key, which gives a per-object subkey with no nonce-reuse limit across objects. Segment counters prevent reordering and truncation.
  - **Library.** `github.com/tink-crypto/tink-go/v2/streamingaead`, Go only. The browser never decrypts a Tink object. Everything the browser opens (identity file, DEK envelopes, content manifest) is an age file, so it needs only typage.
  - **Why not age per object:** see D1.1(b) for the cost of a hybrid stanza per object.
- **L0 associated data.** A length-prefixed, versioned encoding of `("breeze-backup-object/v1", originSnapshotId, objectId, role)`:
  - `role` is one of `file` or `system-state` (the content manifest is an age file, not a Tink object; D1.3);
  - `originSnapshotId` is the snapshot whose run *wrote* the object, so a later incremental that references the object can rebuild the AAD.
  - Codex raised this point; §10 records it.
  - The binding stops an attacker with bucket access from swapping one object for another.
- **L1, DEK envelopes.**
  - **Construction.** age v1 (C2SP spec) encryption of the 32-byte DEK to the org's **recipient set**. The set is the org identity's recipient plus the recovery recipient, plus an escrow recipient if D4 enables one.
  - **Library.** `filippo.io/age` v1.3+ on the agent. It has native hybrid recipients (`age1pq1…`, HPKE with ML-KEM-768 + X25519).
- **L2, the org identity.**
  - It is an age hybrid identity, generated in the browser with the `age-encryption` library (typage). That is pure TypeScript, with no WASM.
  - The private identity is age-encrypted with the **scrypt passphrase recipient**: a standard passphrase-encrypted age file that `age -d` opens.
  - KDF parameters are in D5.
- **PQ consistency.** Go age refuses to mix hybrid and classical recipients in one file. Either every recipient in a set is hybrid (recovery, escrow, restore ephemeral) or none is. **Rec:** all hybrid (§11 O1). Backups are kept for years, so harvest-now-decrypt-later applies.

**D1.3 Object names and manifests**

- **Object names.** Encrypted snapshots write `snapshots/<id>/objects/<objectId>`, where `objectId` is 128 random bits in hex. This still matches the shared key contract `^snapshots/<id>/<rest>$` (`agent/internal/backup/objectkey/objectkey.go:20`). The bucket learns no paths.
- **Manifest split.** The manifest splits in two:
  - **Structural manifest** (`manifest.json`, plaintext, new format version). For each object it holds the object key, ciphertext size, ciphertext SHA-256, key id and origin snapshot id. It holds no paths, plaintext digests or attributes. This is the manifest that GC, vault sync, reconcile, attestation and storage-session authorization read, so none of them needs a key.
  - **Content manifest** (`snapshots/<id>/content-manifest.age`), an **age file encrypted to the org recipient set**, not a Tink object. That way the browser, the recovery client and the recovery kit can open it with the identity alone.
    - It holds what `manifest.json` holds today (paths, attributes, plaintext SHA-256).
    - Each entry also has `{objectId, keyId, originSnapshotId}`.
    - These copies are the only ones trusted for building a release and the AAD. The structural manifest's copies serve GC and storage only, and are never used to decide what to release.
    - The agent can write this file but cannot read it back, because it holds only recipients.
- **Attestation.** It covers the structural manifest, the content-manifest ciphertext and the run's DEK envelope by digest, using the existing control-object attestation (`agent/internal/backup/attestation.go` †). This means a bucket writer cannot replace an object and its adjacent checksum together.
- **Compression.** Unchanged in v1. Cloud providers store raw bytes today. `LocalProvider` gzips objects (`providers/local.go:271-277` †), which gains nothing on ciphertext. The builder sets the per-entry encoding flag so local objects are not gzipped (see the #7621 comment at `snapshot.go:2303-2321` †).

**D1.4 What `keyHash` is**

- `keyHash` is the lowercase hex SHA-256 of the UTF-8 canonical recipient string of the org identity (`age1pq1…`). It is the fingerprint shown to people.
- A new `recipient_set_hash` is the SHA-256 of the sorted, newline-joined recipient strings of a set.
- Agents report the set hash they encrypted to, for each snapshot.

**D1.5 Scope of artifacts**

- **v1:** file backups, system state and BMR, since BMR reads the file and system-state layout.
- **Next:** Hyper-V VHDX and MSSQL `.bak`. They share the `snapshots/<id>/files/` contract but have their own writers (`agent/cmd/breeze-backup/exec_hyperv.go` †).
- **Instant boot and mount** need random-access decryption, which Tink's design permits but which I have not verified in tink-go (§12). **Rec:** exclude those from encrypted snapshots in v1, and say so in the UI (O8).

### D2. Unattended backups

- **What the agent receives** in the `backup_run` payload: `clientEncryption { format: "cse-v1", keyVersionId, recipients[], recipientSetHash }`. A public recipient set is all it needs to encrypt.
- **The agent must never hold:**
  - the passphrase;
  - the org identity;
  - the recovery or escrow identities;
  - any DEK other than the current run's.
  - The one exception is DEKs released for one active restore job, kept in memory for that job only (D3).
- **Order of writes.**
  - The agent uploads the DEK envelope **before** the first object. An object never exists without its envelope.
  - The DEK is zeroed at run end. Go and JavaScript memory erasure is best effort, and the spec does not claim more.
- **Incrementals: the main implementation change** (raised by Codex, adopted).
  - Today the agent decides "unchanged" by reading the previous manifest from the bucket (`incremental.go:56`). Under this model it cannot read the previous content manifest, because that is encrypted under an older DEK it does not have.
  - **Rec:** keep a **device-local incremental index**. It maps path → `{objectId, originSnapshotId, keyId, size, mtime, plaintextSha256}` and is stored in the agent's data directory under the existing agent ACLs.
  - The device already holds the plaintext, so this exposes nothing new. The one exception is digests of files deleted since, a small residue the spec accepts.
  - The index is bound to the attested base snapshot id, the backup identity and the `recipientSetHash`. If it is missing, stale or mismatched, the run is a fresh encrypted full.
- **Fail closed.**
  - When a config requires client-side encryption, a helper that does not advertise the capability `backup.cse.v1` is not dispatched to. The job fails with a clear reason.
  - A helper that advertises the capability but receives no `clientEncryption` block refuses to run. Nothing falls back to plaintext.
  - This applies to every transport, including the legacy raw-credential path, because the encryption sits in the snapshot writer, not the provider.
- **No signature on key change** (agreed with Codex).
  - A hash delivered beside a replacement key authenticates nothing against the API that sends both.
  - A server able to rewrite the recipient set can also run scripts on the agent.
  - Agents report the `recipientSetHash` they used for each snapshot.
  - Recipient-set changes require MFA and are audited. They notify the org's key holders in-app and by email.
- **Downgrade latch** (added in PR review).
  - The agent learns that a config requires client-side encryption from the same API that sends the config. An attacker who can only write to the DB could flip the mode to `provider`, or swap the recipient set, and future backups would follow.
  - **Rec:** once a backup identity has run encrypted, the agent records an agent-local latch (the identity and the recipient-set hash) in its data directory.
  - It then refuses, with a reported error, any later run for that identity that is plaintext or uses a different recipient set.
  - A legitimate change (rotation, disabling encryption) is acknowledged through a separate agent command that carries the new set hash and must arrive with the config change. The agent reports the acknowledgement, and the org's key holders are notified.
  - This stops a silent downgrade by a DB-write-only attacker. It does not stop an attacker with code execution on the agent, who can clear the latch (D9).
  - A signed key-change chain (an Ed25519 key wrapped with the identity) would only stop a DB-write-only attacker. It is listed as a later option, not v1.

### D3. Restore

**Who supplies the passphrase.** A human with a new `backup.keys.release` permission, after MFA, in the
web app. It is never the server, the agent or an AI tool. One passphrase per org key in v1. Per-user
wraps were considered and set aside for v1 (§11 O11).

**Key release protocol (all restore kinds):**

1. A restore is created (route, AI tool or DR execution) with status `awaiting_key_release`. The command goes to the target helper with no keys.
2. The helper generates an **ephemeral hybrid age identity** for that one job. It registers the recipient with the API, bound to the command id.
3. **The browser unlocks the identity.**
   - It fetches the passphrase file.
   - The human types the passphrase.
   - typage decrypts the identity in memory.
   - The identity is never written to `localStorage` or IndexedDB, and is dropped when the dialog closes.
4. **The browser opens the chosen snapshot.**
   - It fetches the snapshot's content manifest (an age file) through a presigned GET, and decrypts it with the identity.
   - From the entries selected for restore, it computes the set of key ids it needs. **The release set comes from the authenticated content manifest, not from a list the API supplies** (Codex, adopted).
   - The manifest's integrity rests on age's AEAD and on the attestation digest, which the browser also checks.
   - Limit: age authenticates the payload, not the sender. Anyone holding the *public* recipient set can write a well-formed manifest. A runtime-compromised API can therefore forge one, which is consistent with D9. A DB-only or bucket-only attacker cannot also make the attestation match.
5. **The browser builds and sends the release.**
   - It decrypts those DEK envelopes.
   - It builds a release document: `{orgId, jobId, targetDeviceId, snapshotId, attestationDigest, recipient, nonce, expiresAt, keys:[{keyId, dek}], entries:[…selected content-manifest entries…]}`. The helper cannot open the content manifest itself, so the browser passes it the entries it needs.
   - It age-encrypts the document to the helper's ephemeral recipient and posts it.
   - The API stores the release only until pickup.
6. **The helper checks and uses it.**
   - It verifies that every binding field matches its own job.
   - It restores using only DEKs in memory, and discards them when the job ends.

**Scope note (Codex).** A released DEK can decrypt *every* object written in that run, not only the
files selected. The existing restriction holds: storage-session key authorization through the file
index lets the helper fetch only the selected objects. This limit is enforced by the server, not by
cryptography, and the UI copy must not overstate it.

**Per path**

| Path | With client-side encryption |
|---|---|
| Managed file restore (same or other device) | Key release as above. The human who starts the restore usually releases in the same dialog. |
| VM / Hyper-V / MSSQL restore | Same, once D1.5 brings those artifacts in. Instant boot and mount are excluded in v1 (O8). |
| **AI tools** | A tool creates the restore in `awaiting_key_release` and returns "a person must release keys in the web app". **No tool schema has a passphrase or key field**; a contract test enforces this. The model never sees the passphrase, an identity or a DEK. |
| **Bare-metal recovery** | <ul><li>**Online:** after the one-time code exchange, the recovery client generates its ephemeral recipient and shows a short fingerprint (a few words) on the console. The browser shows the same words, and the technician confirms they match before releasing. This pairing is an independent check, because a recipient that came through the API proves nothing (Codex, adopted).</li><li>**Offline fallback:** the technician types the passphrase at the recovery console. The recovery client gets the passphrase file from a recovery kit on removable media, or fetches it over the recovery session, and decrypts the identity locally using Go `age` with scrypt. **The org identity then exists in that machine's memory**: the boot media and its client are a party trusted with the whole identity for that session (D9).</li><li>**Local destinations:** the API's local-destination stream must send ciphertext raw, with no gunzip (`recoveryDownloadService.ts`).</li></ul> |
| **No Breeze at all** | A **recovery kit**, downloaded at key creation, holds the passphrase-encrypted identity file, the recipient set and a format note. With the kit, bucket access and the open-source `breeze-backup decrypt` subcommand (to be written), a customer can restore without a Breeze server. Rehearse this path in tests, with the API absent. |
| **DR rehearsal** | The execution pauses at a key-release step for each device. **Unattended rehearsal of encrypted snapshots stops being possible.** The rebuild host's ephemeral recipient is released to like any helper's. The rebuild host has no console, so there is **no independent pairing check** and the recipient's authenticity rests on the API (D9). DR failover creates a recovery with no command (`drExecutionService.ts` †) and goes through the BMR path above. |
| **Post-backup integrity check** | Becomes **ciphertext verification**. It downloads the objects, checks the SHA-256 of the stored bytes against the structural manifest and the structural manifest against the attestation, and parses the Tink header. It runs unattended and is labelled "ciphertext verified", never "verified restorable". |
| **End-of-run self-check** (new) | Before forgetting the DEK, the agent reads back and decrypts a sample of the objects it *just wrote*, comparing plaintext digests. For the content manifest, it checks only the ciphertext digest, because it cannot open the manifest. The label must say it covers only new objects under this run's DEK. |
| **Weekly test restore** | Skipped for encrypted snapshots, with status `requires_key_release`, which never counts as passed. Replaced by a **customer-initiated restore drill**: restore one small historical file with a real release. |
| Readiness / health | Readiness shows "last key drill" next to "last verified". |

**No periodic passphrase prompt.** An earlier draft had the UI ask for the passphrase on a schedule
so a lost passphrase would be found early. Codex argued that this trains users to type the passphrase
whenever asked, and I agree. The UI *reminds* the user to run a drill but never prompts for the
passphrase.

### D4. Lost passphrase

**State it plainly:** without the passphrase *and* without every other recipient's identity, encrypted
backups cannot be recovered by anyone, including Breeze.

| Option | Who can read backups | Consequence |
|---|---|---|
| (a) No recovery path | The passphrase holder only. | One lost passphrase loses all encrypted history. |
| (b) **Mandatory customer-held recovery identity** | The passphrase holder, or whoever holds the recovery identity. | A second recipient on every DEK envelope. Its secret is shown or downloaded once and never stored by Breeze; only its recipient is. |
| (c) Optional MSP (partner) escrow recipient | Adds the partner's key holders, independently, for every DEK addressed to them. | Must be opted into explicitly and visible to the org. Removing it is prospective only (see below). |
| (d) Breeze-held escrow | Adds Breeze. | **Rejected.** It removes the point of option A. |

**Rec (b), mandatory, with (c) deferred (O3, O4).**
- **Prove recovery before encryption starts.** Key setup is not complete until the user proves they can open a test envelope with the recovery identity.
- **Generation.** The recovery identity is generated in the browser by default. The setup also accepts the recipient of an identity generated elsewhere (`age-keygen -pq` on trusted media). That gives a customer an identity the Breeze-served page never saw (Codex, adopted as an option).
- **Removing a recipient** (escrow or a recovery identity) takes effect for future runs only. The next run is a fresh full under the new set. Re-wrapping cannot revoke envelope copies, or keys, that already exist.

### D5. Key-derivation function

| Option | Notes |
|---|---|
| PBKDF2-SHA256 (WebCrypto) | Native and fast to ship. Not memory-hard, so GPUs gain the most. It needs ≥ 600k iterations. Its envelope would be a custom format. |
| Argon2id (WASM: hash-wasm or libsodium.js) | Memory-hard and the best current choice in isolation. It needs `'wasm-unsafe-eval'` in the web CSP (`apps/web/src/middleware.ts:26-27`) and a pinned WASM build. Its envelope would be custom, so `age -d` could not open it. |
| **scrypt via the age passphrase recipient (typage, pure JS)** | Memory-hard (RFC 7914) and needs no CSP change. The result is a standard file that any age implementation opens. Its parameters are fixed by the age spec except the work factor `logN`. |

**Rec: scrypt via age.**
- **Work factor.** `logN = 18`, about 256 MiB per attempt.
- **Import cap.** typage refuses anything above 20, and the builder should cap at 20 as well.
- **Benchmark first.** Measure the weakest supported browser and the BMR recovery environment before fixing `logN`. If it is too slow, choose 17 rather than switching KDF.
- **The passphrase is generated, not chosen** (O2): 8 words from a 7,776-word list, about 103 bits. At that entropy offline guessing is out of reach whatever the KDF, which makes the KDF a second line of defence rather than the only one. The wrapped identity sits on the server, so offline guessing is the main at-rest threat.
- **Upgrades.** `logN` is written in the file. After a successful unlock, if the stored `logN` is below the current policy, the browser re-encrypts the identity at the new work factor and replaces the stored file. Old copies (DB backups, downloaded kits) keep the old factor. A change of KDF algorithm would be a new envelope format version.
- **Outer seal.** The server keeps its outer seal: the stored file is `encryptSecret`-sealed (enc:v3 with AAD = table, column and key id), as `encryptedColumnRegistry.ts:119` already implies. Create and rotate must seal on write, which they do not today (`encryption.ts:58-69`). A DB dump alone then does not even yield the age file.

### D6. Rotation

"Rotate" means four different operations, and the UI names each one:

1. **Change passphrase.** The browser re-encrypts the same identity under a new passphrase. It is cheap, and the recipients do not change. *Old copies* of the file (DB backups, downloaded kits) still open with the old passphrase, and the UI says so.
2. **Rotate the org identity (routine).**
   - The browser generates a new identity and recipient set. New runs encrypt to the new set.
   - For history, the browser unlocks the old identity and **re-wraps every DEK envelope** to the new set. That is one small age operation per run, with **no data re-upload**.
   - **Where the re-wrapped envelopes go.**
     - The DB gains new envelope rows.
     - Bucket copies under object lock cannot be overwritten, so each re-wrapped envelope is also written as a new object, `snapshots/<originSnapshotId>/keys/<keyId>.<recipientSetId>.age`. Content manifests are re-wrapped the same way (`content-manifest.<recipientSetId>.age`).
     - The browser writes these objects through API-issued presigned PUTs that are scoped to exactly those keys.
     - Some destinations cannot be presigned (local, or providers without presigning). There the DB rows are authoritative, and the next helper run on that destination writes the bucket copies.
     - **The DB row and the bucket object must hold identical bytes** (the digest is recorded on the row), because GC and offline restore rely on either one.
   - **The first run after any rotation is a fresh full. This is required, not a default.** The device-local index binds to the `recipientSetHash`, so a changed set always starts a new chain.
   - The old identity can be retired once no retained envelope addresses *only* it. Retiring protects nothing unless the old identity's file and kits are also destroyed, because the old bucket envelopes still open with it.
3. **Rotate after compromise.** Do (2), then force a fresh full chain that references no object under a DEK the suspect identity could open. Delete the old chain when retention and legal hold allow. Re-encrypting existing objects in place is **not offered**: it needs download, decrypt and re-upload, and it conflicts with object lock.
4. **Change recipients** (add or remove the recovery or escrow recipient). Adding one means re-wrapping history to include it. Removing one takes effect for future runs only, followed by a fresh full (D4).

**Interaction with deduplication.** There is no content deduplication (§3.2), so key boundaries affect only
reference chains. An object keeps the DEK of the run that wrote it, for as long as any retained
snapshot references it. **GC must keep a referenced object's originating DEK envelope (DB row and
bucket object) as long as the object itself** (Codex, adopted).

**Delete and retire.** Today's delete refuses while snapshots reference a key (`encryption.ts:138-153`). That
rule stays, extended: an identity cannot be retired while any snapshot under legal hold has an envelope
that only it opens.

### D7. Tenancy

**Shape: org-owned (`org_id NOT NULL`). This is deliberate**, and the PR for the migration must state
why, per the partner-wide-first rule.
- **Not policy.** A key is tenant secret material, not a config or policy row.
- **Containment.** One identity per org keeps compromise contained: a leaked passphrase exposes one customer.
- **Blast radius of the alternative.** A partner-wide key would put every customer of an MSP behind one passphrase.
- **The one partner-shaped piece.** The optional MSP escrow recipient (D4c) is configuration, so it would follow the partner-wide shape (`partner_id` XOR `org_id`). It is deferred with O4.

**Tables (sketch; the plan finalises them):**

| Table | Purpose | Notes |
|---|---|---|
| `storage_encryption_keys` (existing) | One row per org identity version. | New columns: `format` (`age-v1`; NULL marks a legacy row), `recipient` (public), `kdf_log_n`. `key_type` gains `age_hybrid` / `age_x25519`. `encrypted_private_key` holds the sealed age passphrase file. `public_key_pem` is unused for new rows. |
| `backup_encryption_recipient_sets` | Immutable recipient sets. | Holds the set hash and the member recipients (org identity, recovery, escrow). |
| `backup_data_key_envelopes` | DEK envelopes. | `(org_id, key_id, recipient_set_id)` unique; `origin_snapshot_id`; `device_id`; the envelope as text. One key id can have several envelopes after a re-wrap. |
| `backup_key_releases` | Release requests and audit. | Job, target device, ephemeral recipient, binding hash, status, expiry, released by. The ciphertext blob is deleted at pickup. |
| `backup_snapshots` (existing) | Per-snapshot format. | Add `encryption_format`, `recipient_set_id`. `encryption_key_id` becomes "identity version at write time", checked against the org, not just a copy of an agent-supplied UUID (`backupResultPersistence.ts:309-324`). |

**Contracts each new table must meet:**
- **RLS.** Shape 1 RLS, enabled and **forced**, with the four `breeze_has_org_access` policies, in the migration that creates the table.
- **Foreign keys.** Composite `(x, org_id)` FKs that are `DEFERRABLE INITIALLY IMMEDIATE`.
- **Registrations.** Each table goes in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY`.
- **Export classification.**
  - Envelope, release and private-key columns are `excludedSensitive`.
  - Recipients and hashes are `included`. This **reclassifies the existing `storage_encryption_keys.key_hash`** from `excludedSensitive` (`tenantExportPolicyRegistry.ts:991`) to `included`, because D1.4 makes it a public fingerprint. Legacy rows keep it excluded until they are deleted.
  - New columns on existing org-cascade tables are also classified, all as `included` (non-secret): `storage_encryption_keys.format`, `recipient` and `kdf_log_n`, and `backup_snapshots.encryption_format` and `recipient_set_id`.
  - `backup_snapshots.recipient_set_id` is a composite `(recipient_set_id, org_id)` FK, `DEFERRABLE INITIALLY IMMEDIATE`.
  - Any `jsonb` column is `excludedOpen`.
- **Device lists and org-move disposition** (each named explicitly):
  - `backup_data_key_envelopes` is **not re-stamped** by the generic device-org trigger. Its composite `(origin_snapshot_id, org_id)` FK forbids a plain re-stamp, and an envelope addresses one org's recipients. The move flow's re-wrap step (below) writes new rows in the destination org and deletes the source rows.
  - `backup_key_releases` is **deleted** on move. A release is transient, and a pending one is cancelled.
  - The tables are registered in the device-delete lists, and excluded from `CORE_DEVICE_ORG_DENORMALIZED_TABLES` with a comment, following the existing exceptions in that trigger.
- **Contract tests.** These obligations are checked by contract tests, not by review. Per CLAUDE.md, review caught them 0 times out of 5.

**Org merge.** Source keys are repointed to the target (`orgMergeRegistry.ts:1338`). The merged org then
has two identities, each with its own passphrase. One becomes active. The other is restore-only until
its holder re-wraps its history to the active set (D6.2). The page lists both.

Recipient sets are repointed with their identities. Set hashes are unique per `(org_id, set_hash)`. Two distinct identities cannot produce the same hash, so a collision on repoint means the same set was imported twice. The merge keeps one row and repoints references to it.

**Device org move.** Today it re-stamps `backup_snapshots` to the destination (`devices/core.ts:263`).
The DEK envelopes still address the *source* org's recipients, so the destination cannot read the
moved history, and the snapshot FK would point at another tenant's key row.

| Option | Consequence |
|---|---|
| (a) **Block the move while the device has retained encrypted snapshots, unless the move flow includes a re-wrap step.** In that step a source-org key holder unlocks the source identity and re-wraps that device's DEK envelopes to the destination's recipient set, which is public. The alternative is retiring the history in the source org. | Attended, explicit, correct. Adds a step to the move. |
| (b) Move anyway; history unreadable in the destination | Silent data loss for the destination, plus a cross-tenant FK. |
| (c) Snapshots stay in the source org | Conflicts with the generic re-stamp, and needs per-table exclusion like the existing exceptions. |

**Rec (a)** (O7).

### D8. Interactions

1. **Storage-provider encryption.** Keep it as an independent layer. Where a config asks for SSE, the provider still enforces it (`exec_backup.go:55-62`). Client-side encryption also lets the non-S3 providers (Azure, GCS, B2, local) meet an "encryption required" setting, which they cannot today (`exec_backup.go:60-62`). The API's config schema also accepts only `s3` and `local` today (`schemas.ts:160`), so this benefit to Azure, GCS and B2 arrives only once those providers are configurable. Config schema `encryption: boolean` (`schemas.ts:162`) becomes an explicit mode: `provider` | `client` | `both`. One setting, in one home: the backup config, per `docs/agents/settings.md`.
2. **Backup verification.** See D3. Verification results carry what was checked: `ciphertext` or `plaintext (self-check, new objects)` or `restore drill`.
3. **File index.**

   | Option | Loses |
   |---|---|
   | (a) **Agent-reported index in the Breeze DB, as today** (`backupResultPersistence.ts:1807`) | Breeze, but not the bucket, sees names, sizes and mtimes. Server hydration from the bucket (`backupSnapshotFileIndex.ts:137`) cannot run for encrypted snapshots and must skip them; the agent's index then has to be marked complete by the agent's attested count. |
   | (b) Encrypted index, browsed only after an unlock in the browser | Server-side search, `browse_snapshots` for AI tools, file-level reports, and path selection without an unlock. Every browse needs the passphrase. |

   **Rec (a) for v1, stated in the UI and docs; offer (b) later as "hide names from Breeze" (O5).** The index's `backupPath` becomes the opaque object key. Selective restore resolves a path to an object id in the DB, as it does today.
4. **Immutability and legal hold.**
   - Object lock covers the envelope objects too. That is good: an attacker with Breeze access cannot delete the keys that make backups readable, and it is the reason re-wraps write new objects.
   - Legal hold blocks identity retirement (D6), so keys cannot be destroyed to make held data unreadable.
   - Retention and GC keep envelopes for as long as the objects that reference them (D6).
5. **Attestation, reconcile, vault, GC.** All read the structural manifest, which keeps a `backupPath`-style field per object, so the GC spec's parsing changes minimally. Vault sync must also copy each snapshot's `keys/` objects and its `content-manifest*.age` files, all of which sit under that snapshot's prefix.

### D9. Threat model

| Adversary | Protected? | What still leaks or works |
|---|---|---|
| **Bucket read access** (stolen credentials, misconfigured bucket, curious storage provider) | **Yes**, for contents and names. | Object counts and sizes, timing, cross-snapshot reuse (one object referenced by many snapshots), device and snapshot ids. |
| **Bucket write or delete access** | Integrity yes: AEAD plus attestation binding detects tampering. Availability only with object lock. | It can delete or corrupt backups where object lock is not set. |
| **Breeze DB or DB-backup leak, at rest** | **Yes**, for contents. | <ul><li>Names, sizes and mtimes in the file index (D8.3a).</li><li>The age passphrase file, sealed, which an attacker who also has `APP_ENCRYPTION_KEY` can guess against offline. With a generated ~103-bit passphrase that is out of reach.</li></ul> |
| **Breeze API compromised while running** (an attacker controls the code it serves and its agents) | **No, for anything it can reach.** | It can: <ul><li>serve JavaScript that captures the passphrase or identity at creation or at the next unlock, since the unlock page is same-origin code it controls;</li><li>substitute the ephemeral recipient in a release and harvest the DEKs (BMR pairing defeats this only where a human compares the words);</li><li>add a recipient, or swap the set, so future runs encrypt to its key, or to a key nobody holds (denial);</li><li>falsify status and verification results;</li><li>delete backups not under object lock;</li><li>run scripts and push agent updates on every enrolled device, capturing live files, run DEKs and restored data directly.</li></ul> |
| **DB-write-only attacker** (for example SQL injection, with no code execution and no control over served code) | Mostly. | <ul><li>It can change a config's encryption mode or recipient set. The agent's downgrade latch (D2) refuses both without an acknowledgement command, which this attacker cannot send.</li><li>It can forge release requests, but cannot open them, and the browser derives the release set from the content manifest and the attestation.</li><li>It can delete DB rows (envelopes, index). Bucket envelope copies under object lock survive this.</li></ul> |
| **Recovery machine during an offline BMR unlock** | Trusted for that session. | The whole org identity is in its memory (D3). Boot media an attacker has tampered with would capture the identity. Prefer the online pairing path. |
| **DR rehearsal release** | Only as far as the API is trusted. | The rebuild host has no console, so a substituted recipient goes unnoticed (D3). |
| **Retired devices' history under a later runtime compromise** | Only until the shared org identity is captured. | Unenrolling a device creates no confidentiality boundary. Once the identity is captured, every retained envelope it opens is exposed, including those from devices long gone (Codex, adopted). |
| **A malicious insider at the MSP** | Only against insiders without the passphrase and without RMM code execution. | Anyone who can run scripts on endpoints reads live data anyway. |
| **Endpoint compromise** | No. | The agent reads plaintext by design. |
| **Plaintext snapshots written before enablement** | No. | Exposed as before, until retention deletes them. |

The sales and docs claim must be exactly this: **"Backup copies are encrypted with a key Breeze never
holds. A compromised storage bucket or a leaked Breeze database does not expose file contents. A Breeze
server that is compromised while running is inside the trust boundary, as it is for every RMM function."**

Two hardening options are out of scope for v1 and listed for later:
- unlock in a separately distributed native tool (the `breeze-backup` CLI or plain `age`), so that a compromised web origin never sees the passphrase;
- a signed key-change chain (D2).

Two implementation requirements follow from this model:
- **Keep the passphrase out of telemetry.** The passphrase field must be excluded from any session replay or analytics capture.
- **Never post it as a form field.** Unlock code must not submit the passphrase in any request. A test asserts that no request body contains it.

### D10. Migration and rollout

1. **Legacy rows.** Rows created through today's API hold strings that no client could have produced correctly, and no snapshot uses them (§3.1).
   - The migration sets `format = NULL` (legacy) for them. They are never sent to agents.
   - The page lists them as "legacy record, not usable" and lets an admin delete them through the existing route.
   - The migration elects system scope first (`migrationRlsScope.test.ts`) and is idempotent.
2. **Flag.**
   - A server-wide env flag `BACKUP_CLIENT_ENCRYPTION_ENABLED`, default off. With it off the page stays exactly as #12716 left it.
   - With it on, an org opts in by creating an identity, and a config opts in through D8.1.
3. **Agent capability.** Helpers advertise `backup.cse.v1`. Dispatch fails closed for a config that requires client encryption when the helper lacks the capability (D2).
4. **Mixed states.**
   - Each snapshot records `encryption_format` (NULL = plaintext). Restore, verification, GC and index code branch per snapshot.
   - **Chains never mix:** the first encrypted run of a backup identity is a full, and an encrypted manifest never references a plaintext object.
   - Existing plaintext snapshots stay until retention removes them. The page shows how many remain, and offers "delete plaintext history" subject to legal hold and object lock. Nothing is deleted automatically.
5. **What the page shows at each stage:**

   | Stage | Page |
   |---|---|
   | Flag off (today) | Read-only notice from #12716, the provider-encryption note, and any legacy rows. |
   | Flag on, no identity | A setup wizard, in order: <ol><li>generate and show the passphrase;</li><li>generate or import the recovery identity;</li><li>download the recovery kit;</li><li>prove both by opening a test envelope;</li><li>confirm the "unrecoverable if lost" statement by typing it.</li></ol> |
   | Identity active | Fingerprint (`keyHash`), recipient set, the configs using it, counts of encrypted and plaintext snapshots, last restore drill, and a list of releases. |
   | Rotation or retirement | The four named operations from D6, each with its own consequence text. |

6. **Copy.** New English strings go to all 8 locales. The web mutations (create, release, re-wrap) go through `runAction`. Docs (`apps/docs/src/content/docs/backup/encryption.mdx`) are rewritten when the feature ships, not before.

## 7. Component summary (for the plan)

- **Agent (`agent/internal/backup`, `cmd/breeze-backup`).**
  - CSE writer (Tink + age), structural and content manifests, opaque object keys.
  - Device-local incremental index, envelope-first upload, end-of-run self-check.
  - Ephemeral restore identity and release verification.
  - `decrypt` subcommand for the recovery kit, and the BMR recovery client unlock (pairing words plus console passphrase).
  - Capability advertisement.
- **API.**
  - Tables and registrations (D7), payload block (D2), release endpoints and state machine (D3).
  - Structural-manifest consumers: GC, attestation, reconcile, vault, storage-session authorization.
  - Skip bucket hydration for encrypted snapshots; raw ciphertext stream in BMR local download.
  - Verification labels; AI tools return `awaiting_key_release`.
  - Seal the private-key column on write.
  - Retire `managedRestoreSupported` in favour of `restoreRequiresKeyRelease`.
- **Web.** Setup wizard, unlock and release dialog (typage, no persistence, analytics masking), rotation flows, drill, page stages.
- **Tests (red first).**
  - Browser → Go → recovery-client interoperability with fixed vectors.
  - AAD swap and truncation rejection.
  - Release binding mismatches rejected.
  - No tool schema carries a passphrase or key field.
  - No request body contains the passphrase.
  - Fail-closed dispatch to old helpers.
  - GC keeps envelopes.
  - Offline kit restore with no API.
  - Contract suites for the new tables.

## 8. Approaches considered and set aside

- **Option B from the investigation (private key download-only, nothing stored).** This makes `encryptedPrivateKey` optional again, which reverses Wave O of the security tracker. It also stops any technician from restoring without the file. The recovery kit in this spec gives the same "works without Breeze" property, without the reversal.
- **RSA-OAEP via WebCrypto (the existing `rsa_2048` type).** It needs no library, but it is not post-quantum. It would need a custom envelope and a custom passphrase wrap (PBKDF2), and 2048-bit RSA is weak for retention measured in years.
- **age for every object.** One format end to end, but a hybrid stanza costs about 1.1 KB and one KEM operation per object. Every restore would also need the private identity, or per-run identities, on the agent.

## 9. Risks

- **Restores need a person.** Unattended DR rehearsal, the weekly test restore and the AI-only restore all go away for encrypted data. Some MSPs will see this as a regression, and the product must present it as the price of the guarantee.
- **Lost keys are lost data.** D4(b) reduces the risk but does not remove it. A support ticket "we lost both" can only be answered "the data is gone".
- **Format lock-in.** The object format becomes a long-lived contract read by the agent, the recovery client and the kit tool. Interoperability vectors must be checked in before the first encrypted byte ships.
- **Library trust.** typage, `filippo.io/age` and tink-go are the cryptographic core. Pin them, review upgrades as security changes, and confirm the hybrid recipient's interoperability across typage and Go age (§12).
- **Browser memory.** scrypt at `logN = 18` needs about 256 MiB, which may fail on low-memory devices. Benchmark before fixing it (D5).

## 10. Advisor quorum (done 2026-11-26)

- **Who reviewed.** An independent Codex review (`gpt-6.2-astra`, high effort, read-only) covered D2, D3, D4 and D9.
- **How.** It gave its own recommendation first, then critiqued the author's position point by point.
- **Overall.** It agreed with the layering (age identity, scrypt passphrase file, per-run DEK, Tink objects, structural/content manifest split) and returned "agree with changes" on each decision.

| Point | Codex | Resolution |
|---|---|---|
| Incrementals cannot read the previous encrypted manifest | Raised: needs a device-local index, and a fresh full when it is unusable. | **Adopted** (D2). The author's draft missed this. |
| AAD must name the *originating* snapshot | Raised. | **Adopted** (D1.2). |
| Bind the structural manifest, content manifest and envelope into the attestation | Raised. | **Adopted** (D1.3). |
| Release set taken from an API-supplied list | Unsafe: the API could widen a release. | **Adopted:** derived from the AEAD-protected content manifest (D3). |
| Released run DEK covers the whole run | Raised. | **Adopted** as an explicit scope note (D3). |
| Ephemeral recipient comes through the API unauthenticated | Raised: pair independently where possible. | **Adopted** for BMR, the only path with a console. It remains a stated limit for online-device restores (D9). |
| Periodic passphrase prompt | **Disagreed:** it trains users to type the passphrase on request. | **Resolved for Codex:** prompt removed, replaced by a customer-initiated drill (D3). |
| Recovery identity generated in the Breeze-served page | Prefer generation on trusted customer media. | **Partly adopted:** import supported, browser generation stays the default for usability (D4). The owner kept that default, with import allowed (§11 O3). |
| Fingerprint should cover the whole recipient set | Raised. | **Adopted:** `recipient_set_hash` (D1.4). |
| Signing key changes | Agreed it gives no protection against the API itself. | Not in v1 (D2). |
| Mixed hybrid and classical recipients | Go age rejects them. | All-hybrid sets (D1.2). |
| Retired devices give no historical boundary | Raised. | **Adopted** (D9). |
| GC must keep originating envelopes | Raised. | **Adopted** (D6). |

No disagreement is left open.

**PR review round (2026-11-26).** Two reviewers read the first published draft: a crypto and completeness review, and a check of every code citation. The changes they led to are folded into this text:
- the content manifest is now an age file that carries the key ids (D1.3, D3);
- envelopes sit under the snapshot prefix, with a stated write path for re-wraps (D6);
- the BMR offline unlock and DR rehearsal limits are named (D3, D9);
- the downgrade latch and the DB-write-only adversary row are added (D2, D9);
- the tenancy dispositions and export classifications for the new columns are stated (D7);
- the post-rotation full is now normative (D6);
- the citations are corrected (§3).

## 11. Owner decisions (accepted 2026-11-26)

The owner accepted every recommendation in this table on 2026-11-26. Each row is now a decision; the
"Decision" column is what the plan implements.

| # | Question | Decision |
|---|---|---|
| O1 | Post-quantum hybrid (ML-KEM-768 + X25519) or X25519 only? | **Hybrid.** Retention runs for years, and the cost is about 2 KB of recipient and about 1.1 KB per envelope, paid once per run, not per object. |
| O2 | Passphrase: generated only, or user-chosen allowed? | **Generated only** (~103 bits). The wrapped identity sits on the server, and a human-chosen passphrase makes the KDF the only defence. |
| O3 | Recovery identity: mandatory or optional? Browser-generated or imported? | **Mandatory, browser-generated by default, import allowed.** Prove it opens before encryption starts. |
| O4 | Offer an MSP (partner) escrow recipient? | **Not in v1.** Add later as explicit, org-visible opt-in, partner-wide shaped. |
| O5 | File names visible to the Breeze server in v1? | **Yes, and documented.** Hiding them costs search, AI browse and selection without an unlock, so offer it later as a mode. |
| O6 | Accept that DR rehearsal and weekly test restore become attended for encrypted snapshots? | **Accept.** The alternative puts a standing decryption key on a host. |
| O7 | Device org move with encrypted history | **Block unless re-wrapped to the destination or retired**, as a step in the move flow. |
| O8 | Instant boot and VM mount of encrypted snapshots in v1? | **Exclude** until seekable decryption in tink-go is verified. |
| O9 | Format: age envelopes + Tink objects, or a single format? | **age + Tink**, as specified (§8). |
| O10 | v1 artifact scope | **Files, system state and BMR**, then Hyper-V and MSSQL. |
| O11 | One passphrase per org identity, or one wrap per authorized user? | **One per identity in v1.** Per-user wraps give no real revocation, because anyone who unlocked could have kept the identity. |

## 12. Not verified

- **Library capabilities** (taken from vendor docs and release notes during this session, not tested):
  - Whether typage (`age-encryption` 0.3.x) provides hybrid identity generation and scrypt passphrase encryption, interoperable with `filippo.io/age` v1.3's `age1pq1` recipients.
  - Whether tink-go `streamingaead` offers a seekable decrypting reader. This bears on O8.
  - typage's `logN ≤ 20` decode cap.
- **Not measured:** scrypt `logN = 18` time and memory on target browsers and in the BMR environment.
- **Lines read by a code-research pass but not reopened by the author** (marked † above):
  - migration file lines;
  - `snapshot.go:349-431`, `:1233`, `:2303-2321`;
  - `providers/local.go:271-277`, `vault_manifest.go:32-54`, `exec_backup.go:139-200`;
  - `storagesession/descriptor.go`, `attestation.go`, `exec_hyperv.go`;
  - the VM / Hyper-V / MSSQL route lines;
  - `backupEncryption.ts:70-140`, `c2cBackupWorker.ts:6`;
  - the security-tracker excerpt;
  - the DR failover "recovery with no command" behaviour.
  - A citation reviewer later spot-checked many of these and found them accurate.
- **Line approximate:** the BMR local-stream hand-off (`bmr.ts:~1929`) was located only to within that block. The gunzip itself is in `recoveryDownloadService.ts`, at a line not pinned.
- **Not designed in detail:** the agent command that acknowledges a downgrade-latch change (D2). The plan must specify its authentication.
- **Not checked:** whether any production row exists in `storage_encryption_keys`. D10.1 handles either case.
- **Not traced:** whether the web app runs session replay or other analytics that would capture an input field. D9 requires masking either way.
- **Not traced:** what tier-3 AI tool approval requires in practice, or who approves a DR execution.
- **Not checked:** whether `backup_snapshot_attestations` can carry the additional digests without a schema change.
- **Not verified:** the exact behaviour of the generic device-org re-stamp trigger for `backup_snapshots.encryption_key_id`. That column is a plain FK, not composite. The cross-tenant reference in D7 is an inference from the schema.
