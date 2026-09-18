package snmppoll

import (
	"strings"
	"time"
)

// Acquisition modes and cadences, as sent by the server in `oidSpecs`
// (spec §7.1). Unknown values fall back to the defaults rather than failing the
// poll: a newer server must be able to add a mode without bricking old agents.
const (
	ModeGet     = "get"
	ModeWalk    = "walk"
	CadenceFast = "fast"
	CadenceSlow = "slow"
)

// Per-OID error codes carried on a metric row (spec §7.2). The set is CLOSED:
// the server's ingestion and the OID-state derivation both key off it, so a new
// code means a coordinated server change.
const (
	ErrCodeNoSuchObject   = "noSuchObject"
	ErrCodeNoSuchInstance = "noSuchInstance"
	ErrCodeEndOfMib       = "endOfMib"
	ErrCodeTimeout        = "timeout"
	ErrCodeSNMPError      = "snmpError"
	ErrCodeWalkFailed     = "walkFailed"
	ErrCodeTruncated      = "truncated"
)

// OIDSpec is one acquisition instruction from the server.
type OIDSpec struct {
	OID     string `json:"oid"`
	Name    string `json:"name"`
	Mode    string `json:"mode"`
	Cadence string `json:"cadence"`
}

// PollLimits bounds one poll. Enforced per OID and per poll, on rows, bytes and
// wall clock, because each bound fails differently: a 48-port switch blows the
// row bound, a chatty FDB blows the byte bound, and an unresponsive device that
// answers slowly blows neither but holds the agent's poll slot for minutes.
type PollLimits struct {
	MaxRowsPerOID   int
	MaxRowsPerPoll  int
	MaxBytesPerPoll int
	MaxDuration     time.Duration
}

// DefaultPollLimits mirrors POLL_LIMITS in
// apps/api/src/services/snmpOidSpecs.ts and is used whenever the payload omits
// `limits` — i.e. against every server released before W02.
var DefaultPollLimits = PollLimits{
	MaxRowsPerOID:   512,
	MaxRowsPerPoll:  4096,
	MaxBytesPerPoll: 1 << 20,
	MaxDuration:     20 * time.Second,
}

// DefaultMode mirrors the server's rule: a trailing `.0` is SMI's scalar
// instance marker, everything else is a columnar object that has to be walked.
func DefaultMode(oid string) string {
	if strings.HasSuffix(oid, ".0") {
		return ModeGet
	}
	return ModeWalk
}

// SpecsFromOIDs converts a legacy `oids` payload into specs.
//
// Everything becomes `get`. A server that sent no `oidSpecs` never asked for a
// walk, and a new agent that inferred one would start bulk-walking every
// customer switch the moment it upgraded — against a server that has no
// per-instance ingestion to receive the result.
func SpecsFromOIDs(oids []string) []OIDSpec {
	specs := make([]OIDSpec, 0, len(oids))
	for _, oid := range oids {
		oid = strings.TrimSpace(oid)
		if oid == "" {
			continue
		}
		specs = append(specs, OIDSpec{OID: oid, Name: oid, Mode: ModeGet, Cadence: CadenceFast})
	}
	return specs
}

// normalizeOID strips the leading dot gosnmp puts on returned PDU names so a
// base OID from the template ("1.3.6…") and a PDU name (".1.3.6…") compare.
func normalizeOID(oid string) string {
	return strings.TrimPrefix(strings.TrimSpace(oid), ".")
}

// InstanceSuffix returns the index part of a PDU name relative to its base OID:
// "" for a scalar or an exact match, "1.1" for prtMarkerSuppliesLevel.1.1.
//
// The separator is required, not just the prefix: 1.3.6.1.2.1.43.11.1.1.90 is a
// DIFFERENT object from 1.3.6.1.2.1.43.11.1.1.9, not its instance 0.
func InstanceSuffix(baseOID, pduName string) string {
	base := normalizeOID(baseOID)
	name := normalizeOID(pduName)
	if base == "" || name == base {
		return ""
	}
	if strings.HasPrefix(name, base+".") {
		return name[len(base)+1:]
	}
	return ""
}

// FindSpecForOID returns the spec a PDU belongs to, matching on OID rather than
// on response order so a device that reorders or omits varbinds cannot shift
// every metric onto the wrong name.
//
// The LONGEST matching base wins: a template carrying both a table root and one
// of its columns would otherwise collapse every column into the root.
func FindSpecForOID(specs []OIDSpec, pduName string) *OIDSpec {
	name := normalizeOID(pduName)
	var best *OIDSpec
	for i := range specs {
		base := normalizeOID(specs[i].OID)
		if base == "" {
			continue
		}
		if name != base && !strings.HasPrefix(name, base+".") {
			continue
		}
		if best == nil || len(base) > len(normalizeOID(best.OID)) {
			best = &specs[i]
		}
	}
	return best
}
