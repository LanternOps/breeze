package backup

import "github.com/breeze-rmm/agent/internal/backup/integrity"

// IntegrityProtocolVersion is the snapshot integrity protocol this build
// implements, reported by breeze-backup --protocol-info and from there in
// the main agent's heartbeat: 1 = produces snapshot attestations and checks
// an incremental's base; 2 = also checks attestations at every restore.
// 0 = neither.
//
// Version 1 requires everything below to be in the build: provider-reported
// upload digests (content checksums describe the stored bytes), control
// objects recorded with their digests, attestation statements pinned to the
// shared vectors, versioned journals that never attest a resumed publish
// they cannot match, incremental bases checked against their attestation,
// and digested database/VM backups.
//
// Version 2 additionally requires every restore consumer to read the
// integrity expectation delivered with the command or recovery bootstrap and,
// in attested mode, to check each control object against it before parsing
// and every restored object against its manifest entry before publishing
// it: file restore, verify and test restore (including resume and a vault
// copy), Hyper-V, VM and instant-boot restores, database restore and verify,
// bare-metal recovery with its system state, and bare-metal rebuild.
//
// The value lives in the integrity package so the recovery client (bmr),
// which does not import this package, reports the same number.
const IntegrityProtocolVersion = integrity.ProtocolVersion
