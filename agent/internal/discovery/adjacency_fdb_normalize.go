package discovery

import (
	"encoding/json"
	"sort"
	"strconv"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/breeze-rmm/agent/internal/topologycanon"
)

// D13 FDB normalization (SPEC AMENDMENT). Mirrors normalizeFdbSection in
// packages/shared/src/validators/topologyPhysicalNormalized.ts byte for byte and
// is pinned by packages/shared/src/testing/topology-fdb-normalization-v1.json.
// A (bridgeContext, bridgePort) with more than FdbSharedPortMACThreshold
// distinct eligible (learned, unicast, non-zero) MACs collapses to one
// shared_port row. The agent and the API hash this normalized form, so both
// sides bind the same bytes while the wire keeps the raw rows.

// FdbSharedPortMACThreshold is the per-port distinct-MAC limit for per-MAC rows.
const FdbSharedPortMACThreshold = 16

// FdbSharedPortBucket is the size bucket of a collapsed port.
func FdbSharedPortBucket(distinct int) string {
	switch {
	case distinct <= 64:
		return "17-64"
	case distinct <= 256:
		return "65-256"
	}
	return "257+"
}

// IsEligibleFdbRow: learned, unicast (first-octet LSB 0) and non-zero MAC.
func IsEligibleFdbRow(r FdbRow) bool {
	if r.Status != snmppoll.FdbStatusLearned || len(r.MAC) < 2 || r.MAC == "00:00:00:00:00:00" {
		return false
	}
	first, err := strconv.ParseUint(r.MAC[:2], 16, 8)
	return err == nil && first&1 == 0
}

// FdbSharedPortRow is one collapsed shared/upstream port.
type FdbSharedPortRow struct {
	RowType       string  `json:"rowType"`
	RowKey        string  `json:"rowKey"`
	BridgeContext string  `json:"bridgeContext"`
	BridgePort    uint32  `json:"bridgePort"`
	IfIndex       *uint32 `json:"ifIndex"`
	SizeBucket    string  `json:"sizeBucket"`
}

// NormalizedFdbRow is either a per-MAC row or a shared_port row.
type NormalizedFdbRow struct {
	Row    *FdbRow
	Shared *FdbSharedPortRow
}

func (r NormalizedFdbRow) key() string {
	if r.Shared != nil {
		return r.Shared.RowKey
	}
	return r.Row.RowKey
}

func (r NormalizedFdbRow) MarshalJSON() ([]byte, error) {
	if r.Shared != nil {
		return json.Marshal(r.Shared)
	}
	return json.Marshal(r.Row)
}

// FdbNormalizationMetadata counts what the normalization did not retain per MAC.
type FdbNormalizationMetadata struct {
	IneligibleRowCount int `json:"ineligibleRowCount"`
	SharedPortCount    int `json:"sharedPortCount"`
	CollapsedRowCount  int `json:"collapsedRowCount"`
}

// NormalizedFdbSection is the digest form of an FDB section.
type NormalizedFdbSection struct {
	Kind            string                   `json:"kind"`
	ContextKey      string                   `json:"contextKey"`
	ContentDigest   string                   `json:"contentDigest"`
	Outcome         Outcome                  `json:"outcome"`
	ReasonCode      string                   `json:"reasonCode,omitempty"`
	RowCount        int                      `json:"rowCount"`
	OmittedRowCount int                      `json:"omittedRowCount,omitempty"`
	Rows            []NormalizedFdbRow       `json:"rows"`
	Metadata        FdbNormalizationMetadata `json:"metadata"`
}

// NormalizeFdbSection applies the D13 rule. Outcome/reason/omissions and the
// input contentDigest are kept verbatim; callers recompute the digest.
func NormalizeFdbSection(s PhysicalSection) NormalizedFdbSection {
	type portID struct {
		ctx  string
		port uint32
	}
	var order []portID
	ports := map[portID][]FdbRow{}
	ineligible := 0
	for _, r := range s.Fdb {
		if !IsEligibleFdbRow(r) {
			ineligible++
			continue
		}
		id := portID{r.BridgeContext, r.BridgePort}
		if _, ok := ports[id]; !ok {
			order = append(order, id)
		}
		ports[id] = append(ports[id], r)
	}
	out := NormalizedFdbSection{Kind: s.Kind, ContextKey: s.ContextKey, ContentDigest: s.ContentDigest, Outcome: s.Outcome,
		ReasonCode: s.ReasonCode, OmittedRowCount: s.OmittedRowCount, Rows: []NormalizedFdbRow{}}
	out.Metadata.IneligibleRowCount = ineligible
	for _, id := range order {
		rows := ports[id]
		macs := map[string]bool{}
		ifIndexes := map[uint32]bool{}
		nilIf := false
		for _, r := range rows {
			macs[r.MAC] = true
			if r.IfIndex == nil {
				nilIf = true
			} else {
				ifIndexes[*r.IfIndex] = true
			}
		}
		if len(macs) <= FdbSharedPortMACThreshold {
			for i := range rows {
				r := rows[i]
				out.Rows = append(out.Rows, NormalizedFdbRow{Row: &r})
			}
			continue
		}
		shared := &FdbSharedPortRow{RowType: "shared_port", RowKey: "shared_port|" + id.ctx + "|" + strconv.FormatUint(uint64(id.port), 10),
			BridgeContext: id.ctx, BridgePort: id.port, SizeBucket: FdbSharedPortBucket(len(macs))}
		// TS keeps first.ifIndex when the set of ifIndex values (null included) has one member.
		distinct := len(ifIndexes)
		if nilIf {
			distinct++
		}
		if distinct == 1 && rows[0].IfIndex != nil {
			v := *rows[0].IfIndex
			shared.IfIndex = &v
		}
		out.Rows = append(out.Rows, NormalizedFdbRow{Shared: shared})
		out.Metadata.SharedPortCount++
		out.Metadata.CollapsedRowCount += len(rows)
	}
	sort.SliceStable(out.Rows, func(i, j int) bool { return out.Rows[i].key() < out.Rows[j].key() })
	out.RowCount = len(out.Rows)
	return out
}

// semanticDigestForm is the semantic object of a section's normalized form.
func semanticDigestForm(s PhysicalSection) (map[string]any, error) {
	if s.Kind != SectionFDB {
		return semanticSection(s)
	}
	m, err := topologycanon.Object(NormalizeFdbSection(s))
	if err != nil {
		return nil, err
	}
	delete(m, "contentDigest")
	rows, ok := m["rows"].([]any)
	if !ok {
		return nil, topologycanon.ErrMalformed
	}
	return m, topologycanon.SortByStringField(rows, "rowKey")
}

// CanonicalizeAdjacencyScopeNormalized is the canonical scope bytes over the
// normalized (digest) form — what the transport digest hashes.
func CanonicalizeAdjacencyScopeNormalized(id AdjacencyDigestIdentity, s PhysicalSection) ([]byte, error) {
	sem, err := semanticDigestForm(s)
	if err != nil {
		return nil, err
	}
	h := id.header()
	h["section"] = sem
	return topologycanon.StableJSON(h)
}

// CanonicalizeAdjacencyReportNormalized is the canonical report bytes over normalized scopes.
func CanonicalizeAdjacencyReportNormalized(id AdjacencyDigestIdentity, sections []PhysicalSection) ([]byte, error) {
	out := make([]any, 0, len(sections))
	for _, s := range sections {
		sem, err := semanticDigestForm(s)
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

// AdjacencyScopeDigest is the lowercase SHA-256 hex transport digest of one scope.
func AdjacencyScopeDigest(id AdjacencyDigestIdentity, s PhysicalSection) (string, error) {
	b, err := CanonicalizeAdjacencyScopeNormalized(id, s)
	if err != nil {
		return "", err
	}
	return topologycanon.DigestHex(b), nil
}

// AdjacencyReportDigest is the transport digest of a whole per-target snapshot.
func AdjacencyReportDigest(id AdjacencyDigestIdentity, sections []PhysicalSection) (string, error) {
	b, err := CanonicalizeAdjacencyReportNormalized(id, sections)
	if err != nil {
		return "", err
	}
	return topologycanon.DigestHex(b), nil
}
