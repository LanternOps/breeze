package oemupdates

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"
)

func TestMarkerWithoutEndReportsInterrupted(t *testing.T) {
	store := newMemStore()
	if _, ok := ReadInterruptedMarker(store); ok {
		t.Fatal("no marker must not read as interrupted")
	}
	started := time.Date(2026, 11, 18, 1, 5, 0, 0, time.UTC)
	m := Marker{CommandID: "c1", Lane: LaneDell, StartedAt: started, Stage: StageInstalling, FlashStarted: true}
	if err := WriteMarker(store, m); err != nil {
		t.Fatal(err)
	}
	got, ok := ReadInterruptedMarker(store)
	if !ok {
		t.Fatal("a marker with no end must read as interrupted")
	}
	if got.CommandID != "c1" || !got.FlashStarted || !got.StartedAt.Equal(started) {
		t.Fatalf("marker round trip lost data: %+v", got)
	}

	ended := started.Add(time.Hour)
	m.EndedAt = &ended
	if err := WriteMarker(store, m); err != nil {
		t.Fatal(err)
	}
	if _, ok := ReadInterruptedMarker(store); ok {
		t.Fatal("an ended marker must not read as interrupted")
	}
}

func TestCorruptMarkerIsNotInterruptedAndIsReported(t *testing.T) {
	store := newMemStore()
	_ = store.WriteFile(markerFile, []byte("{not json"))
	if _, ok := ReadInterruptedMarker(store); ok {
		t.Fatal("an unreadable marker cannot name a command, so it is not an interrupted run")
	}
	if _, err := ReadMarker(store); err == nil {
		t.Fatal("ReadMarker must surface a corrupt marker as an error")
	}
}

func TestInterruptedResultFromMarker(t *testing.T) {
	m := Marker{CommandID: "c1", Lane: LaneDell, ToolVersion: "5.7.2", Stage: StageInstalling, FlashStarted: true}
	r := m.InterruptedResult()
	if r.Outcome != OutcomeInterrupted || r.Lane != LaneDell || r.ToolVersion == nil || *r.ToolVersion != "5.7.2" {
		t.Fatalf("interrupted result = %+v", r)
	}
	if r.ErrorCode == nil || *r.ErrorCode != "agent_restarted_during_installing" {
		t.Fatalf("errorCode = %v", r.ErrorCode)
	}
	if err := r.Validate(); err != nil {
		t.Fatalf("interrupted result must satisfy the contract: %v", err)
	}
}

// TestResultRoundTripsSharedFixture is the cross-language contract: the Go
// result type must read the shared zod fixture and write back the same keys
// and values.
func TestResultRoundTripsSharedFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "shared", "src", "validators", "__fixtures__", "oemUpdateResult.sample.json"))
	if err != nil {
		t.Fatalf("read shared fixture: %v", err)
	}
	var result RunResult
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&result); err != nil {
		t.Fatalf("decode fixture strictly: %v", err)
	}
	if err := result.Validate(); err != nil {
		t.Fatalf("fixture fails Go validation: %v", err)
	}
	out, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var want, got map[string]any
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(keys(want), keys(got)) {
		t.Fatalf("keys differ:\nfixture %v\ngo      %v", keys(want), keys(got))
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("values differ:\nfixture %v\ngo      %v", want, got)
	}
}

func TestEmptyResultMarshalsArraysNotNull(t *testing.T) {
	out, err := json.Marshal(RunResult{Lane: LaneDell, Outcome: OutcomeNoUpdates, Takeover: TakeoverNotAttempted})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	_ = json.Unmarshal(out, &got)
	for _, k := range []string{"items", "skippedCategories"} {
		if _, ok := got[k].([]any); !ok {
			t.Fatalf("%s = %v, want an array (zod rejects null)", k, got[k])
		}
	}
	for _, k := range []string{"toolVersion", "rawExitCode", "errorCode"} {
		if v, present := got[k]; !present || v != nil {
			t.Fatalf("%s must be present and null, got %v (present=%v)", k, v, present)
		}
	}
}

func keys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
