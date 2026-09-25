package discovery

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/breeze-rmm/agent/internal/topologycanon"
)

// Adjacency v2 (Collection spec §7). The shared zod contract
// (packages/shared/src/validators/topologyPhysical.ts) is normative; these
// structs mirror it field for field and are checked against the shared
// fixture packages/shared/src/testing/topology-adjacency-v2.json. The legacy
// DeviceAdjacency shape is unchanged and is derived from V2 by an adapter.

// Outcome is a per-scope collection outcome.
type Outcome = topologycanon.Outcome

const (
	OutcomeComplete     = topologycanon.Complete
	OutcomePartial      = topologycanon.Partial
	OutcomeFailed       = topologycanon.Failed
	OutcomeUnsupported  = topologycanon.Unsupported
	OutcomeNotAttempted = topologycanon.NotAttempted
)

// Section kinds of the adjacency envelope.
const (
	SectionLLDP       = "lldp"
	SectionCDP        = "cdp"
	SectionFDB        = "fdb"
	SectionInterfaces = "interfaces"
)

// Port namespaces. Numeric equality across namespaces never proves a match.
const (
	PortNamespaceIfIndex        = "if_index"
	PortNamespaceIfName         = "if_name"
	PortNamespaceBridgePort     = "bridge_port"
	PortNamespaceLLDPLocal      = "lldp_local"
	PortNamespaceControllerPort = "controller_port"
)

// Limits shared with the API validator.
const (
	AdjacencyV2MaxBytes   = 4 * 1024 * 1024 // one report = one target snapshot = one body
	AdjacencyV2FDBMaxRows = 20000
)

// PortRef is a tagged port reference; ResolvedInterfaceKey is set only from an
// explicit mapping or a unique subtype-aware inventory match.
type PortRef struct {
	Namespace            string  `json:"namespace"`
	Value                string  `json:"value"`
	ResolvedInterfaceKey *string `json:"resolvedInterfaceKey"`
}

// TypedID preserves the chassis/port/device identity namespace.
type TypedID struct {
	Subtype string `json:"subtype"`
	Value   string `json:"value"`
}

// LldpRow is one lldpRemTable entry. TimeMark is observation metadata only.
type LldpRow struct {
	RowKey          string   `json:"rowKey"`
	TimeMark        uint32   `json:"timeMark"`
	RemoteIndex     uint32   `json:"remoteIndex"`
	LocalPort       PortRef  `json:"localPort"`
	RemoteChassis   TypedID  `json:"remoteChassis"`
	RemotePort      TypedID  `json:"remotePort"`
	RemoteSysName   string   `json:"remoteSysName,omitempty"`
	RemoteAddresses []string `json:"remoteAddresses,omitempty"`
}

// CdpRow is one cdpCacheTable entry; LocalPort is always the cache ifIndex.
type CdpRow struct {
	RowKey        string  `json:"rowKey"`
	DeviceIndex   uint32  `json:"deviceIndex"`
	LocalPort     PortRef `json:"localPort"`
	RemoteDevice  TypedID `json:"remoteDevice"`
	RemotePort    TypedID `json:"remotePort"`
	RemoteAddress string  `json:"remoteAddress,omitempty"`
}

// FdbRow is the wire FDB row, produced by snmppoll.AssembleFdbV2.
type FdbRow = snmppoll.FdbV2Row

// PhysicalInterfaceRow is one SNMP interface-inventory row.
type PhysicalInterfaceRow struct {
	RowKey        string  `json:"rowKey"`
	InterfaceKey  string  `json:"interfaceKey"`
	IfIndex       uint32  `json:"ifIndex"`
	IfName        *string `json:"ifName"`
	IfAlias       *string `json:"ifAlias"`
	PhysAddress   *string `json:"physAddress"`
	LldpLocalPort *uint32 `json:"lldpLocalPort"`
	BridgePort    *uint32 `json:"bridgePort"`
}

// LldpRowKey / CdpRowKey / InterfaceRowKey mirror the shared validator's derived keys.
func LldpRowKey(localPortNum, remoteIndex uint32) string {
	return strconv.FormatUint(uint64(localPortNum), 10) + "." + strconv.FormatUint(uint64(remoteIndex), 10)
}
func CdpRowKey(ifIndex, deviceIndex uint32) string {
	return strconv.FormatUint(uint64(ifIndex), 10) + "." + strconv.FormatUint(uint64(deviceIndex), 10)
}
func InterfaceRowKey(ifIndex uint32) string { return strconv.FormatUint(uint64(ifIndex), 10) }

// PhysicalSection is the discriminated Section<T> of the adjacency envelope:
// exactly the slice named by Kind is marshalled as `rows`.
type PhysicalSection struct {
	Kind            string
	ContextKey      string
	ContentDigest   string
	Outcome         Outcome
	ReasonCode      string
	OmittedRowCount int
	RowCount        int
	Lldp            []LldpRow
	Cdp             []CdpRow
	Fdb             []FdbRow
	Interfaces      []PhysicalInterfaceRow
}

type physicalSectionWire struct {
	Kind            string          `json:"kind"`
	ContextKey      string          `json:"contextKey"`
	ContentDigest   string          `json:"contentDigest"`
	Outcome         Outcome         `json:"outcome"`
	ReasonCode      string          `json:"reasonCode,omitempty"`
	RowCount        int             `json:"rowCount"`
	OmittedRowCount int             `json:"omittedRowCount,omitempty"`
	Rows            json.RawMessage `json:"rows"`
}

func marshalRows[T any](rows []T) (json.RawMessage, int, error) {
	if rows == nil {
		rows = []T{}
	}
	b, err := json.Marshal(rows)
	return b, len(rows), err
}

// Len is the number of positive rows carried for Kind.
func (s PhysicalSection) Len() int {
	switch s.Kind {
	case SectionLLDP:
		return len(s.Lldp)
	case SectionCDP:
		return len(s.Cdp)
	case SectionFDB:
		return len(s.Fdb)
	case SectionInterfaces:
		return len(s.Interfaces)
	}
	return 0
}

func (s PhysicalSection) MarshalJSON() ([]byte, error) {
	var rows json.RawMessage
	var err error
	switch s.Kind {
	case SectionLLDP:
		rows, _, err = marshalRows(s.Lldp)
	case SectionCDP:
		rows, _, err = marshalRows(s.Cdp)
	case SectionFDB:
		rows, _, err = marshalRows(s.Fdb)
	case SectionInterfaces:
		rows, _, err = marshalRows(s.Interfaces)
	default:
		return nil, fmt.Errorf("adjacency section kind %q: %w", s.Kind, topologycanon.ErrMalformed)
	}
	if err != nil {
		return nil, err
	}
	return json.Marshal(physicalSectionWire{Kind: s.Kind, ContextKey: s.ContextKey, ContentDigest: s.ContentDigest, Outcome: s.Outcome,
		ReasonCode: s.ReasonCode, RowCount: s.RowCount, OmittedRowCount: s.OmittedRowCount, Rows: rows})
}

func (s *PhysicalSection) UnmarshalJSON(b []byte) error {
	var w physicalSectionWire
	if err := json.Unmarshal(b, &w); err != nil {
		return err
	}
	*s = PhysicalSection{Kind: w.Kind, ContextKey: w.ContextKey, ContentDigest: w.ContentDigest, Outcome: w.Outcome,
		ReasonCode: w.ReasonCode, RowCount: w.RowCount, OmittedRowCount: w.OmittedRowCount}
	switch w.Kind {
	case SectionLLDP:
		s.Lldp = []LldpRow{}
		return json.Unmarshal(w.Rows, &s.Lldp)
	case SectionCDP:
		s.Cdp = []CdpRow{}
		return json.Unmarshal(w.Rows, &s.Cdp)
	case SectionFDB:
		s.Fdb = []FdbRow{}
		return json.Unmarshal(w.Rows, &s.Fdb)
	case SectionInterfaces:
		s.Interfaces = []PhysicalInterfaceRow{}
		return json.Unmarshal(w.Rows, &s.Interfaces)
	}
	return fmt.Errorf("adjacency section kind %q: %w", w.Kind, topologycanon.ErrMalformed)
}

// AdjacencySource is the target the snapshot describes (authority is resolved server-side).
type AdjacencySource struct {
	SourceKey string  `json:"sourceKey"`
	Address   string  `json:"address"`
	Zone      *string `json:"zone"`
}

// AdjacencyManifestScope declares one requested protocol/context scope. It must
// equal its section's outcome, counts and digest.
type AdjacencyManifestScope struct {
	Kind            string  `json:"kind"`
	ContextKey      string  `json:"contextKey"`
	Outcome         Outcome `json:"outcome"`
	RowCount        int     `json:"rowCount"`
	OmittedRowCount int     `json:"omittedRowCount,omitempty"`
	ContentDigest   string  `json:"contentDigest"`
}

// AdjacencyManifest is the final scope manifest of a full report.
type AdjacencyManifest struct {
	Scopes []AdjacencyManifestScope `json:"scopes"`
}

// AdjacencyV2 is one authorized target's full snapshot, or an unchanged confirmation.
type AdjacencyV2 struct {
	Version                 int                `json:"version"`
	ParentJobID             string             `json:"parentJobId"`
	ParentCommandID         string             `json:"parentCommandId"`
	ProducerEpoch           string             `json:"producerEpoch"`
	SnapshotID              string             `json:"snapshotId"`
	Sequence                string             `json:"sequence"`
	CapturedAt              string             `json:"capturedAt"`
	CaptureAgeAtSendMS      *int64             `json:"captureAgeAtSendMs"`
	ExpectedIntervalSeconds int                `json:"expectedIntervalSeconds"`
	ContentDigest           string             `json:"contentDigest"`
	Source                  AdjacencySource    `json:"source"`
	ReportKind              string             `json:"reportKind"`
	Sections                []PhysicalSection  `json:"sections,omitempty"`
	FinalManifest           *AdjacencyManifest `json:"finalManifest,omitempty"`
	BaseSnapshotID          string             `json:"baseSnapshotId,omitempty"`
}

// MarshalJSON keeps full/unchanged fields exclusive (the shared schema rejects mixing).
func (r AdjacencyV2) MarshalJSON() ([]byte, error) {
	type alias AdjacencyV2
	switch r.ReportKind {
	case "full":
		if r.FinalManifest == nil {
			return nil, errors.New("full adjacency report requires a final scope manifest")
		}
		if r.FinalManifest.Scopes == nil {
			r.FinalManifest = &AdjacencyManifest{Scopes: []AdjacencyManifestScope{}}
		}
		r.BaseSnapshotID = ""
		b, err := json.Marshal(alias(r))
		if err != nil || len(r.Sections) > 0 {
			return b, err
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(b, &fields); err != nil {
			return nil, err
		}
		fields["sections"] = json.RawMessage("[]")
		return json.Marshal(fields)
	case "unchanged":
		r.Sections, r.FinalManifest = nil, nil
		return json.Marshal(alias(r))
	}
	return nil, fmt.Errorf("adjacency report kind %q: %w", r.ReportKind, topologycanon.ErrMalformed)
}

// AdjacencyDigestIdentity binds a digest to the server-authorized source identity and target scope.
type AdjacencyDigestIdentity struct {
	SourceIdentity string
	ProducerEpoch  string
	Source         AdjacencySource
}

func (id AdjacencyDigestIdentity) header() map[string]any {
	return map[string]any{"canonicalizationVersion": 1, "contract": "adjacency_v2", "sourceIdentity": id.SourceIdentity,
		"version": 2, "producerEpoch": id.ProducerEpoch, "source": id.Source}
}

// semanticSection drops the digest and LLDP timeMark and orders set-like values.
func semanticSection(s PhysicalSection) (map[string]any, error) {
	m, err := topologycanon.Object(s)
	if err != nil {
		return nil, err
	}
	delete(m, "contentDigest")
	rows, ok := m["rows"].([]any)
	if !ok {
		return nil, topologycanon.ErrMalformed
	}
	if s.Kind == SectionLLDP {
		for _, v := range rows {
			row, ok := v.(map[string]any)
			if !ok {
				return nil, topologycanon.ErrMalformed
			}
			delete(row, "timeMark")
			if addrs, ok := row["remoteAddresses"].([]any); ok {
				topologycanon.SortValues(addrs, func(v any) string { s, _ := v.(string); return s })
			}
		}
	}
	return m, topologycanon.SortByStringField(rows, "rowKey")
}

func sortedScopes(sections []any) {
	topologycanon.SortValues(sections, func(v any) string {
		m := v.(map[string]any)
		return topologycanon.StableString([]any{m["contextKey"], m["kind"]})
	})
}

// CanonicalizeAdjacencyScope returns the canonical bytes of one authorized scope.
func CanonicalizeAdjacencyScope(id AdjacencyDigestIdentity, s PhysicalSection) ([]byte, error) {
	sem, err := semanticSection(s)
	if err != nil {
		return nil, err
	}
	h := id.header()
	h["section"] = sem
	return topologycanon.StableJSON(h)
}

// CanonicalizeAdjacencyReport returns the canonical bytes of a whole snapshot.
// Excluded: sequence, timestamps, snapshot/parent ids and timeMark.
func CanonicalizeAdjacencyReport(id AdjacencyDigestIdentity, sections []PhysicalSection) ([]byte, error) {
	out := make([]any, 0, len(sections))
	for _, s := range sections {
		sem, err := semanticSection(s)
		if err != nil {
			return nil, err
		}
		out = append(out, sem)
	}
	sortedScopes(out)
	h := id.header()
	h["sections"] = out
	return topologycanon.StableJSON(h)
}
