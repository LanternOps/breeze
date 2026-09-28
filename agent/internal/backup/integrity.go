package backup

// IntegrityProtocolVersion is the snapshot integrity protocol this build
// implements, reported by breeze-backup --protocol-info and from there in
// the main agent's heartbeat: 1 = produces snapshot attestations and checks
// an incremental's base; 2 = also checks attestations at every restore.
// 0 = neither.
const IntegrityProtocolVersion = 0
