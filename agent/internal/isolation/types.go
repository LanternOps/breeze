// Package isolation is the agent side of network-isolation containment
// (#10088): it cuts the device off the network except for the Breeze
// management plane, proves the cut, and always lets go again.
//
// The package owns the mechanics; the server owns the decision. Pieces:
//   - a pure state machine (Step) over the journalled local phase;
//   - the fenced, fsynced journal (subpackage journal);
//   - allowlist resolution with a last-known-good address set (Resolver);
//   - apply → verify → commit, with a 90 s one-shot rollback armed first;
//   - the offline break-glass code;
//   - one Isolator per OS (WFP, nftables, pf). Until an OS's isolator ships,
//     the platform isolator reports capability 0 and nothing can be applied.
//
// Import discipline: the separately installed recovery binary links this
// package (it needs the isolators to delete rules), and it must survive a
// broken agent. So this package imports nothing from heartbeat, config,
// updater or remote/tools (deps_test.go pins that).
package isolation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/netip"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/wire"
)

// Wire vocabulary shared with packages/shared/src/utils/networkIsolation.ts.
const (
	DesiredIsolated = "isolated"
	DesiredReleased = "released"

	ScopeBreeze = "breeze"
	ScopeAny    = "any"

	KindHost = "host"
	KindCIDR = "cidr"

	ProtoTCP    = "tcp"
	ProtoUDP    = "udp"
	ProtoUDPTCP = "udp+tcp"
)

// Episode states an agent reports (AGENT_REPORTABLE_STATES).
const (
	StateApplying        = "applying"
	StateApplied         = "applied"
	StateVerified        = "verified"
	StateReleased        = "released"
	StateExpired         = "expired"
	StateFailed          = "failed"
	StateReleasedLocally = "released_locally"
	StateSelfReleased    = "self_released"
)

// Failure codes (ISOLATION_FAILURE_CODES) an agent can produce.
const (
	FailUnsupportedPlatform     = "unsupported_platform"
	FailMechanismUnavailable    = "mechanism_unavailable"
	FailApplyError              = "apply_error"
	FailControlPlaneUnreachable = "control_plane_unreachable"
	FailEnforcementNotObserved  = "enforcement_not_observed"
)

// Release kinds (ISOLATION_RELEASE_KINDS).
const (
	ReleaseConsole     = "console"
	ReleaseAI          = "ai"
	ReleaseExpired     = "expired"
	ReleaseDeadMan     = "dead_man"
	ReleaseLocalCode   = "local_code"
	ReleaseLocalForced = "local_forced"
	ReleaseUninstall   = "uninstall"
	ReleaseSystem      = "system"
)

// AllowEntry is one server-built permit (isolationAllowEntrySchema).
type AllowEntry = journal.AllowEntry

// Spec is the desired isolation for one episode at one generation, as the
// server sends it: in the isolate command's `parameters` (plus the top-level
// `breakGlassSecret`, Gate B decision 4 vii) and in the heartbeat response's
// containment block.
type Spec struct {
	IsolationID    string       `json:"isolationId"`
	Generation     int          `json:"generation"`
	ExpiresAt      time.Time    `json:"expiresAt"`
	DeadManSeconds int          `json:"deadManSeconds"`
	RemoteRelay    bool         `json:"remoteRelay"`
	Allow          []AllowEntry `json:"allow"`
	// BreakGlassSecret is the 32-byte per-episode secret. encoding/json
	// carries []byte as padded standard base64, which is exactly the wire
	// shape (`breakGlassSecret`, 43 characters plus `=`). Never logged.
	BreakGlassSecret []byte `json:"breakGlassSecret,omitempty"`
}

// Desired is networkIsolationDesiredSchema: a Spec plus the server's intent.
// A `released` tombstone carries an empty allow list and never the secret.
type Desired struct {
	Spec
	Desired string `json:"desired"`
}

// DesiredBlock is the heartbeat response's `containment` block
// (containmentDesiredBlockSchema). The server always sends it; a nil
// NetworkIsolation means the server asserts nothing (never a release).
type DesiredBlock struct {
	NetworkIsolation *Desired `json:"networkIsolation"`
}

// ReportEvent is one journal event as reported (isolationJournalEventSchema).
type ReportEvent = journal.Event

// Report is networkIsolationReportSchema: what the agent tells the server
// about its episode on every heartbeat. With no episode it is the
// "nothing Breeze-owned is installed" form: no isolationId, phase "none".
//
// Terminal classification travels in Events: a failure is journalled as
// `failed_<code>` and a release as `released_<kind>` (e.g.
// `released_local_forced`), so the server never parses LastError.
type Report struct {
	IsolationID     string        `json:"isolationId,omitempty"`
	Generation      int           `json:"generation,omitempty"`
	JournalSeq      int64         `json:"journalSeq"`
	State           string        `json:"state,omitempty"`
	Phase           journal.Phase `json:"phase"`
	Mechanism       string        `json:"mechanism,omitempty"`
	AppliedAt       *time.Time    `json:"appliedAt,omitempty"`
	LastVerifiedAt  *time.Time    `json:"lastVerifiedAt,omitempty"`
	RuleDigest      string        `json:"ruleDigest,omitempty"`
	LastError       string        `json:"lastError,omitempty"`
	SecretAckSeq    *int64        `json:"secretAckSeq,omitempty"`
	RecoveryVersion string        `json:"recoveryVersion,omitempty"`
	Events          []ReportEvent `json:"events,omitempty"`
}

// CommandResultBody is the structured result of an isolate or release command
// (spec §3.3 "Agent result", plus the plan's ordering key journalSeq).
type CommandResultBody struct {
	IsolationID string     `json:"isolationId"`
	Generation  int        `json:"generation"`
	JournalSeq  int64      `json:"journalSeq"`
	State       string     `json:"state,omitempty"`
	Mechanism   string     `json:"mechanism,omitempty"`
	AppliedAt   *time.Time `json:"appliedAt,omitempty"`
	VerifiedAt  *time.Time `json:"verifiedAt,omitempty"`
	Rollback    bool       `json:"rollback"`
	// FailureCode is the bare episode failure code (spec §3.3 result
	// `errorCode`), not the wire.CommandErrorCode on CommandOutcome.
	FailureCode string `json:"errorCode,omitempty"`
}

// CommandOutcome is what HandleIsolate and HandleRelease return. It carries
// the fields of tools.CommandResult that matter here; the heartbeat wiring
// (W1e) copies them across. This package cannot return tools.CommandResult
// itself: remote/tools imports updater and config, which the recovery binary
// must never link (see the package comment).
type CommandOutcome struct {
	// Status is "completed" or "failed".
	Status    string
	Error     string
	ErrorCode wire.CommandErrorCode
	Result    *CommandResultBody
}

// Failed reports whether the command failed.
func (o CommandOutcome) Failed() bool { return o.Status != "completed" }

// Capability is what this build can do on this OS. Version 0 means it cannot
// isolate at all. Ready is reported only once the mechanism and the recovery
// artifact are installed and usable (plan quorum #8).
type Capability struct {
	Version           int
	Mechanism         string
	UnsupportedReason string
	Ready             bool
}

// Digest identifies an installed rule set.
type Digest string

// Marker is an opaque snapshot of the isolator's drop accounting (a WFP
// net-event cursor, a pf or nft counter), taken before the negative probe.
type Marker struct {
	Value uint64
	At    time.Time
}

// ResolvedEntry is an allowlist entry with the addresses to permit.
type ResolvedEntry struct {
	AllowEntry
	// Addrs is every prefix to permit for the entry: the resolved addresses
	// of a host (as /32 or /128), or the entry's own CIDR.
	Addrs []netip.Prefix
	// Proxy marks the entry added for the transport's effective proxy.
	Proxy bool
}

// ResolvedSpec is what an Isolator installs: numeric permits only.
type ResolvedSpec struct {
	IsolationID string
	Generation  int
	RemoteRelay bool
	Entries     []ResolvedEntry
}

// Digest is a canonical hash of the permits. Isolators may report their own
// digest of what they read back from the engine; the fake and the tests use
// this one.
func (r ResolvedSpec) Digest() Digest {
	lines := make([]string, 0, len(r.Entries))
	for _, e := range r.Entries {
		addrs := make([]string, 0, len(e.Addrs))
		for _, a := range e.Addrs {
			addrs = append(addrs, a.String())
		}
		sort.Strings(addrs)
		ports := make([]string, 0, len(e.Ports))
		for _, p := range e.Ports {
			ports = append(ports, strconv.Itoa(int(p)))
		}
		sort.Strings(ports)
		lines = append(lines, strings.Join([]string{e.Kind, e.Host, e.CIDR, e.Proto, e.Scope, strings.Join(ports, ","), strings.Join(addrs, ","), strconv.FormatBool(e.Proxy)}, "|"))
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return Digest(hex.EncodeToString(sum[:]))
}

// Isolator is one OS mechanism. Every method acts only on Breeze-owned
// objects (own WFP provider/sublayer, own nft table, own pf anchor).
//
// Contract the manager relies on:
//   - Verify of an unchanged rule set returns exactly the digest Apply
//     returned (the commit check compares them); ResolvedSpec.Digest is one
//     way to compute it, but a real isolator should digest what it reads back
//     from the engine.
//   - Owned and Release must never report success they cannot observe: an
//     isolator that cannot see the engine returns an error, so a release is
//     never confirmed falsely.
type Isolator interface {
	Capability() Capability
	// Apply atomically replaces the Breeze-owned rule set with spec (both
	// address families or neither) and returns the installed digest.
	Apply(ctx context.Context, spec ResolvedSpec) (Digest, error)
	// Verify reads the installed rules back and returns their digest.
	Verify(ctx context.Context, spec ResolvedSpec) (Digest, error)
	// Release deletes every Breeze-owned rule.
	Release(ctx context.Context) error
	// Owned reports whether any Breeze-owned rule is installed.
	Owned(ctx context.Context) (bool, error)
	// Mark snapshots the drop accounting before a negative probe.
	Mark(ctx context.Context) (Marker, error)
	// DropObserved reports whether a Breeze-owned drop rule fired since m.
	DropObserved(ctx context.Context, since Marker) (bool, error)
}

// RecoveryScheduler arms the OS-level timers that run the recovery binary
// without the agent (spec §3.6 items 1–2). Every Arm* reads its task back
// before returning nil.
type RecoveryScheduler interface {
	ArmProvisional(attemptID string, deadline time.Time) error
	DisarmProvisional(attemptID string) error
	ArmExpiry(isolationID string, generation int, at time.Time) error
	EnsurePoll() error
	RemoveAll() error
	// Ready reports whether the recovery artifact passed its self-test and
	// its tasks can be registered; the string says why not.
	Ready() (bool, string)
}
