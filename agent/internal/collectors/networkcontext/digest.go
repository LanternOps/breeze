package networkcontext

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"time"

	"github.com/breeze-rmm/agent/internal/topologycanon"
)

type Report struct {
	Version                 int               `json:"version"`
	ProducerEpoch           string            `json:"producerEpoch"`
	SnapshotID              string            `json:"snapshotId"`
	Sequence                string            `json:"sequence"`
	CapturedAt              string            `json:"capturedAt"`
	CaptureAgeAtSendMS      *int64            `json:"captureAgeAtSendMs"`
	ExpectedIntervalSeconds int               `json:"expectedIntervalSeconds"`
	ContentDigest           string            `json:"contentDigest"`
	ReportKind              string            `json:"reportKind"`
	BaseSnapshotID          string            `json:"baseSnapshotId,omitempty"`
	Capabilities            []Capability      `json:"capabilities,omitempty"`
	ContextManifest         *Manifest         `json:"contextManifest,omitempty"`
	Sections                []json.RawMessage `json:"sections,omitempty"`
}

// stableJSON is the shared topology byte rule (single-sourced in topologycanon).
func stableJSON(v any) ([]byte, error) { return topologycanon.StableJSON(v) }
func canonicalObject(v any) (map[string]any, error) {
	b, e := stableJSON(v)
	if e != nil {
		return nil, e
	}
	var m map[string]any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	e = d.Decode(&m)
	return m, e
}
func stableString(v any) string { b, _ := stableJSON(v); return string(b) }
func sortValues(a []any, key func(any) string) {
	sort.SliceStable(a, func(i, j int) bool { return key(a[i]) < key(a[j]) })
}
func objectField(k string) func(any) string {
	return func(v any) string { return v.(map[string]any)[k].(string) }
}
func semanticSection(s map[string]any, capturedAt string) (map[string]any, error) {
	delete(s, "contentDigest")
	rows, ok := s["rows"].([]any)
	if !ok {
		return nil, ErrMalformed
	}
	for _, value := range rows {
		row, ok := value.(map[string]any)
		if !ok {
			return nil, ErrMalformed
		}
		for _, field := range []string{"addresses", "nextHops", "selectors", "unsupportedSelectorKinds"} {
			if a, ok := row[field].([]any); ok {
				sortValues(a, stableString)
			}
		}
		if seconds, ok := row["expiresInSeconds"].(json.Number); ok {
			capture, e := time.Parse(time.RFC3339Nano, capturedAt)
			if e != nil {
				return nil, e
			}
			n, e := seconds.Int64()
			if e != nil {
				return nil, e
			}
			delete(row, "expiresInSeconds")
			row["expiresAt"] = capture.Add(time.Duration(n) * time.Second).UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}
	sortValues(rows, objectField("rowKey"))
	return s, nil
}
func canonicalParts(report Report) (map[string]any, []any, error) {
	m, e := canonicalObject(report)
	if e != nil {
		return nil, nil, e
	}
	manifest, ok := m["contextManifest"].(map[string]any)
	if !ok {
		return nil, nil, ErrMalformed
	}
	contexts, ok := manifest["contexts"].([]any)
	if !ok {
		return nil, nil, ErrMalformed
	}
	for _, value := range contexts {
		c := value.(map[string]any)
		families, ok := c["families"].([]any)
		if !ok {
			return nil, nil, ErrMalformed
		}
		sortValues(families, stableString)
	}
	sortValues(contexts, objectField("contextKey"))
	sections, ok := m["sections"].([]any)
	if !ok {
		return nil, nil, ErrMalformed
	}
	sortValues(sections, func(v any) string {
		s := v.(map[string]any)
		return stableString([]any{s["contextKey"], s["kind"], s["addressFamily"]})
	})
	for i, value := range sections {
		s, e := semanticSection(value.(map[string]any), report.CapturedAt)
		if e != nil {
			return nil, nil, e
		}
		sections[i] = s
	}
	return manifest, sections, nil
}
func CanonicalizeReport(report Report, sourceIdentity string) ([]byte, error) {
	if report.ReportKind != "full" || report.Version != 1 || !validKey(sourceIdentity) {
		return nil, ErrMalformed
	}
	manifest, sections, e := canonicalParts(report)
	if e != nil {
		return nil, e
	}
	caps := append([]Capability{}, report.Capabilities...)
	sort.Slice(caps, func(i, j int) bool { return caps[i].Name < caps[j].Name })
	return stableJSON(map[string]any{"canonicalizationVersion": 1, "sourceIdentity": sourceIdentity, "version": report.Version, "producerEpoch": report.ProducerEpoch, "capabilities": caps, "contextManifest": manifest, "sections": sections})
}
func CanonicalizeSection(report Report, section json.RawMessage, sourceIdentity string) ([]byte, error) {
	manifest, _, e := canonicalParts(report)
	if e != nil {
		return nil, e
	}
	s, e := canonicalObject(section)
	if e != nil {
		return nil, e
	}
	s, e = semanticSection(s, report.CapturedAt)
	if e != nil {
		return nil, e
	}
	var matched any
	for _, value := range manifest["contexts"].([]any) {
		c := value.(map[string]any)
		if c["contextKey"] == s["contextKey"] {
			matched = c
			break
		}
	}
	if matched == nil {
		return nil, errors.New("section context missing from manifest")
	}
	return stableJSON(map[string]any{"canonicalizationVersion": 1, "sourceIdentity": sourceIdentity, "version": report.Version, "producerEpoch": report.ProducerEpoch, "contextManifest": map[string]any{"outcome": manifest["outcome"], "context": matched}, "section": s})
}
func digestBytes(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }
func SetDigests(report *Report, sourceIdentity string) error {
	for i, raw := range report.Sections {
		b, e := CanonicalizeSection(*report, raw, sourceIdentity)
		if e != nil {
			return e
		}
		s, e := canonicalObject(raw)
		if e != nil {
			return e
		}
		s["contentDigest"] = digestBytes(b)
		report.Sections[i], e = stableJSON(s)
		if e != nil {
			return e
		}
	}
	b, e := CanonicalizeReport(*report, sourceIdentity)
	if e != nil {
		return e
	}
	report.ContentDigest = digestBytes(b)
	return nil
}

// MarshalJSON preserves required empty arrays for full reports and omits all
// full-only properties for unchanged reports (the latter schema is strict).
func (r Report) MarshalJSON() ([]byte, error) {
	type alias Report
	b, err := json.Marshal(alias(r))
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(b, &fields); err != nil {
		return nil, err
	}
	if r.ReportKind == "full" {
		if len(r.Capabilities) == 0 {
			fields["capabilities"] = json.RawMessage("[]")
		}
		if len(r.Sections) == 0 {
			fields["sections"] = json.RawMessage("[]")
		}
		if r.ContextManifest == nil {
			return nil, ErrMalformed
		}
		delete(fields, "baseSnapshotId")
	} else {
		delete(fields, "capabilities")
		delete(fields, "sections")
		delete(fields, "contextManifest")
	}
	return json.Marshal(fields)
}
