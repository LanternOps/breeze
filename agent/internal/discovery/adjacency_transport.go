package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/google/uuid"
)

// Discovery adjacency transport (M2 D14): one AdjacencyV2 report per
// authorized SNMP target per collection, POSTed to
// /api/v1/agents/:id/topology/adjacency. The parent discovery command's
// `topology` block authorizes it; without that block (an older server) only the
// legacy `adjacency` result array is produced. Per target the agent keeps a
// small durable baseline (acknowledged digest/snapshot, sequence) so an
// identical re-read is sent as `unchanged`, with a full revalidation at least
// daily. An interrupted upload salvages nothing: the next collection resends.

const (
	maxAdjacencyTargets          = 4096
	adjacencyFullRevalidInterval = 24 * time.Hour
	// JSON.stringify and encoding/json differ slightly (Go escapes <>&), so keep
	// a margin under the server's 4 MiB report guard.
	adjacencyReportBudget = AdjacencyV2MaxBytes - 16*1024
)

var adjacencyProtocolOrder = []string{SectionLLDP, SectionCDP, SectionFDB, SectionInterfaces}
var hex64 = regexp.MustCompile(`^[a-f0-9]{64}$`)

// AdjacencyDispatch is the parent command's `topology` block.
type AdjacencyDispatch struct {
	AcceptedAdjacencyVersions []int     `json:"acceptedAdjacencyVersions"`
	ProducerEpoch             string    `json:"producerEpoch"`
	SourceIdentity            string    `json:"sourceIdentity"`
	Deadline                  time.Time `json:"deadline"`
	Protocols                 []string  `json:"protocols"`
	Contexts                  []string  `json:"contexts"`
	ExpectedIntervalSeconds   int       `json:"expectedIntervalSeconds"`
}

// ParseAdjacencyDispatch returns the dispatch only when it advertises adjacency
// v2 and is well formed; otherwise the caller stays legacy-only.
func ParseAdjacencyDispatch(raw any) (AdjacencyDispatch, bool) {
	if raw == nil {
		return AdjacencyDispatch{}, false
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return AdjacencyDispatch{}, false
	}
	var d AdjacencyDispatch
	if err := json.Unmarshal(b, &d); err != nil {
		return AdjacencyDispatch{}, false
	}
	v2 := false
	for _, v := range d.AcceptedAdjacencyVersions {
		v2 = v2 || v == 2
	}
	if !v2 || !hex64.MatchString(d.ProducerEpoch) || d.SourceIdentity == "" || len(d.SourceIdentity) > 255 || d.Deadline.IsZero() ||
		d.ExpectedIntervalSeconds < 60 || d.ExpectedIntervalSeconds > 86400 || len(d.Contexts) != 1 || d.Contexts[0] == "" || len(d.Protocols) == 0 {
		return AdjacencyDispatch{}, false
	}
	seen := map[string]bool{}
	for _, p := range d.Protocols {
		if seen[p] || (p != SectionLLDP && p != SectionCDP && p != SectionFDB && p != SectionInterfaces) {
			return AdjacencyDispatch{}, false
		}
		seen[p] = true
	}
	return d, true
}

// ---- durable per-target state ----

// AdjacencyPending names the report awaiting a server verdict.
type AdjacencyPending struct {
	SnapshotID string `json:"snapshotId"`
	Sequence   string `json:"sequence"`
	Digest     string `json:"digest"`
	ReportKind string `json:"reportKind"`
}

// TargetAdjacencyState is one target's acknowledged baseline.
type TargetAdjacencyState struct {
	ProducerEpoch  string            `json:"producerEpoch"`
	SourceIdentity string            `json:"sourceIdentity"`
	Sequence       uint64            `json:"sequence"`
	AckSnapshotID  string            `json:"ackSnapshotId,omitempty"`
	AckDigest      string            `json:"ackDigest,omitempty"`
	LastFullAt     time.Time         `json:"lastFullAt,omitempty"`
	Pending        *AdjacencyPending `json:"pending,omitempty"`
	UpdatedAt      time.Time         `json:"updatedAt"`
}

// AdjacencyStateStore owns a private state file (0600, atomic replace). A
// missing or malformed file starts empty: losing a baseline only costs one
// full report, and sequences are time-seeded so they never regress.
type AdjacencyStateStore struct {
	mu      sync.Mutex
	path    string
	targets map[string]TargetAdjacencyState
}

func OpenAdjacencyState(path string) *AdjacencyStateStore {
	s := &AdjacencyStateStore{path: path, targets: map[string]TargetAdjacencyState{}}
	b, err := os.ReadFile(path)
	if err != nil || len(b) > 64*1024*1024 {
		return s
	}
	var data struct {
		Targets map[string]TargetAdjacencyState `json:"targets"`
	}
	if json.Unmarshal(b, &data) == nil && data.Targets != nil {
		s.targets = data.Targets
	}
	return s
}

// Target returns a copy of the target's state (zero value when absent).
func (s *AdjacencyStateStore) Target(target string) TargetAdjacencyState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.targets[target]
	if st.Pending != nil {
		p := *st.Pending
		st.Pending = &p
	}
	return st
}

func (s *AdjacencyStateStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.targets)
}

// update mutates one target in memory and evicts the oldest beyond the bound.
// Flush persists; Send flushes once per collection, not once per target.
func (s *AdjacencyStateStore) update(target string, fn func(*TargetAdjacencyState), now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := s.targets[target]
	fn(&st)
	st.UpdatedAt = now
	s.targets[target] = st
	if len(s.targets) > maxAdjacencyTargets {
		type aged struct {
			key string
			at  time.Time
		}
		all := make([]aged, 0, len(s.targets))
		for k, v := range s.targets {
			all = append(all, aged{k, v.UpdatedAt})
		}
		sort.Slice(all, func(i, j int) bool {
			if all[i].at.Equal(all[j].at) {
				return all[i].key < all[j].key
			}
			return all[i].at.Before(all[j].at)
		})
		for _, a := range all[:len(all)-maxAdjacencyTargets] {
			delete(s.targets, a.key)
		}
	}
}

// Flush writes the state file atomically (0600).
func (s *AdjacencyStateStore) Flush() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.Marshal(struct {
		Targets map[string]TargetAdjacencyState `json:"targets"`
	}{s.targets})
	if err != nil {
		return err
	}
	return writeAdjacencyStateFile(s.path, b)
}

func writeAdjacencyStateFile(path string, b []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".topology-adjacency-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer func() { _ = os.Remove(name) }()
	if err = f.Chmod(0600); err == nil {
		if _, err = f.Write(b); err == nil {
			err = f.Sync()
		}
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(name, path)
}

// ---- wire ----

type adjacencyPostBody struct {
	ParentJobID string      `json:"parentJobId"`
	Report      AdjacencyV2 `json:"report"`
}

// AdjacencyReceipt is one section's ingest verdict.
type AdjacencyReceipt struct {
	Kind             string `json:"kind"`
	ContextKey       string `json:"contextKey"`
	Accepted         bool   `json:"accepted"`
	Reason           string `json:"reason,omitempty"`
	AcceptedSequence string `json:"acceptedSequence,omitempty"`
	ContentDigest    string `json:"contentDigest,omitempty"`
	BaseSnapshotID   string `json:"baseSnapshotId,omitempty"`
}

// AdjacencyResponse is the synchronous 200 response.
type AdjacencyResponse struct {
	Accepted          bool               `json:"accepted"`
	Reason            string             `json:"reason,omitempty"`
	RetryAfterSeconds int                `json:"retryAfterSeconds,omitempty"`
	ContentDigest     string             `json:"contentDigest,omitempty"`
	BaseSnapshotID    string             `json:"baseSnapshotId,omitempty"`
	Receipts          []AdjacencyReceipt `json:"receipts"`
}

// AdjacencyPoster delivers one encoded body and returns the HTTP status and body.
type AdjacencyPoster interface {
	Post(ctx context.Context, body []byte) (int, []byte, error)
}

// HTTPAdjacencyPoster posts through httputil (retries 429/5xx/transport errors).
type HTTPAdjacencyPoster struct {
	Client        *http.Client
	URL           string
	Authorization string
	Retry         httputil.RetryConfig
}

func (p *HTTPAdjacencyPoster) Post(ctx context.Context, body []byte) (int, []byte, error) {
	client := p.Client
	if client == nil {
		client = http.DefaultClient
	}
	headers := http.Header{"Content-Type": {"application/json"}, "Authorization": {p.Authorization}}
	resp, err := httputil.Do(ctx, client, http.MethodPost, p.URL, body, headers, p.Retry)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, b, err
}

// ---- report construction ----

// AdjacencyTransport posts one collection's per-target reports.
type AdjacencyTransport struct {
	Dispatch        AdjacencyDispatch
	ParentJobID     string
	ParentCommandID string
	Poster          AdjacencyPoster
	State           *AdjacencyStateStore
	Now             func() time.Time
}

// AdjacencyPostOutcome summarizes one target (logging/tests only).
type AdjacencyPostOutcome struct {
	Target     string
	ReportKind string
	Accepted   bool
	Reason     string
}

// requestedSections returns exactly the requested protocol scopes in canonical
// order; a requested scope the collection did not produce is `not_attempted`.
func (d AdjacencyDispatch) requestedSections(collected []PhysicalSection) []PhysicalSection {
	ctx := d.Contexts[0]
	want := map[string]bool{}
	for _, p := range d.Protocols {
		want[p] = true
	}
	byKind := map[string]PhysicalSection{}
	for _, s := range collected {
		if want[s.Kind] && s.ContextKey == ctx {
			byKind[s.Kind] = s
		}
	}
	out := []PhysicalSection{}
	for _, kind := range adjacencyProtocolOrder {
		if !want[kind] {
			continue
		}
		s, ok := byKind[kind]
		if !ok {
			s = newSection(kind, ctx).withOutcome(OutcomeNotAttempted, "not_collected")
		}
		out = append(out, s)
	}
	return out
}

func sortRowsByKey(s *PhysicalSection) {
	switch s.Kind {
	case SectionLLDP:
		sort.SliceStable(s.Lldp, func(i, j int) bool { return s.Lldp[i].RowKey < s.Lldp[j].RowKey })
	case SectionCDP:
		sort.SliceStable(s.Cdp, func(i, j int) bool { return s.Cdp[i].RowKey < s.Cdp[j].RowKey })
	case SectionFDB:
		sort.SliceStable(s.Fdb, func(i, j int) bool { return s.Fdb[i].RowKey < s.Fdb[j].RowKey })
	case SectionInterfaces:
		sort.SliceStable(s.Interfaces, func(i, j int) bool { return s.Interfaces[i].RowKey < s.Interfaces[j].RowKey })
	}
}

func truncateRows(s *PhysicalSection, keep int) {
	switch s.Kind {
	case SectionLLDP:
		s.Lldp = s.Lldp[:keep]
	case SectionCDP:
		s.Cdp = s.Cdp[:keep]
	case SectionFDB:
		s.Fdb = s.Fdb[:keep]
	case SectionInterfaces:
		s.Interfaces = s.Interfaces[:keep]
	}
}

// setDigests fills every scope digest, the manifest and the report digest.
func setAdjacencyDigests(r *AdjacencyV2, id AdjacencyDigestIdentity) error {
	scopes := make([]AdjacencyManifestScope, 0, len(r.Sections))
	for i := range r.Sections {
		s := &r.Sections[i]
		s.RowCount = s.Len()
		d, err := AdjacencyScopeDigest(id, *s)
		if err != nil {
			return err
		}
		s.ContentDigest = d
		scopes = append(scopes, AdjacencyManifestScope{Kind: s.Kind, ContextKey: s.ContextKey, Outcome: s.Outcome, RowCount: s.RowCount,
			OmittedRowCount: s.OmittedRowCount, ContentDigest: d})
	}
	r.FinalManifest = &AdjacencyManifest{Scopes: scopes}
	d, err := AdjacencyReportDigest(id, r.Sections)
	r.ContentDigest = d
	return err
}

// boundAdjacencyReport trims the largest positive section (FDB first) to a
// rowKey-sorted prefix, marked partial/limit_exceeded, until the report fits.
func boundAdjacencyReport(r *AdjacencyV2, id AdjacencyDigestIdentity, budget int) error {
	for {
		b, err := json.Marshal(r)
		if err != nil {
			return err
		}
		if len(b) <= budget {
			return nil
		}
		idx := -1
		for _, kind := range adjacencyProtocolOrder {
			for i := range r.Sections {
				if r.Sections[i].Kind == kind && r.Sections[i].Len() > 0 && idx < 0 {
					idx = i
				}
			}
		}
		if idx < 0 {
			return errors.New("adjacency report exceeds the byte limit with no rows to trim")
		}
		s := &r.Sections[idx]
		sectionBytes, _ := json.Marshal(*s)
		n := s.Len()
		excess := len(b) - budget
		drop := int(int64(n)*int64(excess)/int64(len(sectionBytes))) + n/100 + 1
		if drop > n {
			drop = n
		}
		sortRowsByKey(s)
		truncateRows(s, n-drop)
		s.OmittedRowCount += drop
		s.Outcome, s.ReasonCode = OutcomePartial, "limit_exceeded"
		if err := setAdjacencyDigests(r, id); err != nil {
			return err
		}
	}
}

// Send posts every target's report and updates its baseline. It never posts
// at or after the dispatch deadline.
func (t *AdjacencyTransport) Send(ctx context.Context, targets []TargetPhysical) []AdjacencyPostOutcome {
	out := make([]AdjacencyPostOutcome, 0, len(targets))
	for _, target := range targets {
		out = append(out, t.sendOne(ctx, target))
	}
	if len(targets) > 0 {
		if err := t.State.Flush(); err != nil {
			slog.Warn("adjacency state not persisted", "error", err.Error())
		}
	}
	return out
}

func (t *AdjacencyTransport) now() time.Time {
	if t.Now != nil {
		return t.Now()
	}
	return time.Now()
}

func (t *AdjacencyTransport) sendOne(ctx context.Context, target TargetPhysical) AdjacencyPostOutcome {
	result := AdjacencyPostOutcome{Target: target.Target}
	now := t.now()
	if !now.Before(t.Dispatch.Deadline) {
		result.Reason = "deadline_passed"
		return result
	}
	d := t.Dispatch
	source := AdjacencySource{SourceKey: "snmp:" + target.Target, Address: target.Target}
	id := AdjacencyDigestIdentity{SourceIdentity: d.SourceIdentity, ProducerEpoch: d.ProducerEpoch, Source: source}
	captured := target.CapturedAt
	if captured.IsZero() || captured.After(now) {
		captured = now
	}
	age := now.Sub(captured).Milliseconds()
	report := AdjacencyV2{Version: 2, ParentJobID: t.ParentJobID, ParentCommandID: t.ParentCommandID, ProducerEpoch: d.ProducerEpoch,
		SnapshotID: uuid.NewString(), CapturedAt: captured.UTC().Format(time.RFC3339Nano), CaptureAgeAtSendMS: &age,
		ExpectedIntervalSeconds: d.ExpectedIntervalSeconds, Source: source, ReportKind: "full", Sections: d.requestedSections(target.Sections)}
	if err := setAdjacencyDigests(&report, id); err == nil {
		err = boundAdjacencyReport(&report, id, adjacencyReportBudget)
		if err != nil {
			result.Reason = "report_unbounded"
			return result
		}
	} else {
		result.Reason = "digest_failed"
		return result
	}

	st := t.State.Target(target.Target)
	if st.ProducerEpoch != d.ProducerEpoch || st.SourceIdentity != d.SourceIdentity {
		st = TargetAdjacencyState{Sequence: st.Sequence}
	}
	seq := st.Sequence + 1
	if ms := uint64(now.UnixMilli()); ms > seq {
		seq = ms
	}
	report.Sequence = strconv.FormatUint(seq, 10)
	if st.AckDigest != "" && st.AckSnapshotID != "" && st.AckDigest == report.ContentDigest && now.Sub(st.LastFullAt) < adjacencyFullRevalidInterval {
		report.ReportKind, report.BaseSnapshotID = "unchanged", st.AckSnapshotID
		report.Sections, report.FinalManifest = nil, nil
	}
	result.ReportKind = report.ReportKind
	pending := &AdjacencyPending{SnapshotID: report.SnapshotID, Sequence: report.Sequence, Digest: report.ContentDigest, ReportKind: report.ReportKind}
	t.State.update(target.Target, func(s *TargetAdjacencyState) {
		if s.ProducerEpoch != d.ProducerEpoch || s.SourceIdentity != d.SourceIdentity {
			*s = TargetAdjacencyState{ProducerEpoch: d.ProducerEpoch, SourceIdentity: d.SourceIdentity}
		}
		s.Sequence, s.Pending = seq, pending
	}, now)

	body, err := json.Marshal(adjacencyPostBody{ParentJobID: t.ParentJobID, Report: report})
	if err != nil {
		result.Reason = "encode_failed"
		return result
	}
	status, respBody, err := t.Poster.Post(ctx, body)
	if err != nil || status >= 500 || status == http.StatusTooManyRequests {
		// Transient: keep the baseline; the next collection resends.
		result.Reason = "transport_unavailable"
		if err == nil {
			result.Reason = fmt.Sprintf("http_%d", status)
		}
		return result
	}
	var resp AdjacencyResponse
	accepted := false
	if status >= 200 && status < 300 && json.Unmarshal(respBody, &resp) == nil && resp.Accepted && resp.ContentDigest == report.ContentDigest && resp.BaseSnapshotID != "" {
		accepted = true
	} else if status >= 200 && status < 300 {
		result.Reason = resp.Reason
		if result.Reason == "" {
			result.Reason = "not_accepted"
		}
	} else {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(respBody, &e)
		result.Reason = e.Error
		if result.Reason == "" {
			result.Reason = fmt.Sprintf("http_%d", status)
		}
	}
	finished := t.now()
	t.State.update(target.Target, func(s *TargetAdjacencyState) {
		s.Pending = nil
		if !accepted {
			s.AckSnapshotID, s.AckDigest, s.LastFullAt = "", "", time.Time{}
			return
		}
		s.AckSnapshotID, s.AckDigest = resp.BaseSnapshotID, resp.ContentDigest
		if report.ReportKind == "full" {
			s.LastFullAt = now
		}
	}, finished)
	result.Accepted = accepted
	if !accepted {
		slog.Warn("adjacency report not accepted", "target", target.Target, "kind", report.ReportKind, "reason", result.Reason)
	}
	return result
}
