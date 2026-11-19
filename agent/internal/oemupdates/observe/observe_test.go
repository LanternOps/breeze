package observe

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// decodeStrict decodes a wire result the way the API's strict schema reads it:
// an unknown key anywhere fails.
func decodeStrict(t *testing.T, data []byte) Result {
	t.Helper()
	var r Result
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&r); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return r
}

func semanticJSON(t *testing.T, data []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return v
}

// TestGoldenWireRoundTrip pins the Go types to the frozen contract: each golden
// the vitest suite also reads decodes with no unknown key, re-marshals to the
// same JSON, and passes the Go-side contract check.
func TestGoldenWireRoundTrip(t *testing.T) {
	for _, lane := range []string{LaneSurface, LaneHP, LaneLenovo} {
		t.Run(lane, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata", "wire", lane+".json"))
			if err != nil {
				t.Fatal(err)
			}
			r := decodeStrict(t, data)
			if r.Lane != lane {
				t.Fatalf("lane = %q, want %q", r.Lane, lane)
			}
			if err := r.Validate(); err != nil {
				t.Fatalf("golden fails the Go contract check: %v", err)
			}
			out, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(semanticJSON(t, data), semanticJSON(t, out)) {
				t.Fatalf("round trip changed the golden:\n got %s", out)
			}
		})
	}
}

// TestEmptyListsMarshalAsArrays: the schema refuses null for a list, and a nil
// Go slice marshals as null. A host whose every read fails must still produce
// arrays.
func TestEmptyListsMarshalAsArrays(t *testing.T) {
	for _, lane := range []string{LaneSurface, LaneHP, LaneLenovo} {
		t.Run(lane, func(t *testing.T) {
			r := Collect(t.Context(), failingHost(t), Request{Lane: lane, ObserveLevel: LevelPassive}, "0.131.0")
			out, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Contains(out, []byte(":null,\"conflicts\"")) || bytes.Contains(out, []byte(`"tools":null`)) ||
				bytes.Contains(out, []byte(`"errors":null`)) || bytes.Contains(out, []byte(`"conflicts":null`)) ||
				bytes.Contains(out, []byte(`"updates":null`)) || bytes.Contains(out, []byte(`"categories":null`)) {
				t.Fatalf("a list marshalled as null: %s", out)
			}
			back := decodeStrict(t, out)
			if err := back.Validate(); err != nil {
				t.Fatalf("all-failing host result fails the contract: %v\n%s", err, out)
			}
		})
	}
}

func TestParseRequest(t *testing.T) {
	good := `{"lane":"surface","observeLevel":"passive","escrowedProtectorIds":["3c6c3b5e-0d1e-4a3e-9d0a-6f2f8c1b2a11"]}`
	req, err := ParseRequest([]byte(good))
	if err != nil {
		t.Fatalf("good payload refused: %v", err)
	}
	if req.Lane != LaneSurface || len(req.EscrowedProtectorIDs) != 1 {
		t.Fatalf("parsed %+v", req)
	}

	many := make([]string, 17)
	for i := range many {
		many[i] = `"3c6c3b5e-0d1e-4a3e-9d0a-6f2f8c1b2a11"`
	}
	bad := map[string]string{
		"scan level":                  `{"lane":"surface","observeLevel":"scan","escrowedProtectorIds":[]}`,
		"unknown key":                 `{"lane":"surface","observeLevel":"passive","escrowedProtectorIds":[],"x":1}`,
		"dell lane":                   `{"lane":"dell","observeLevel":"passive","escrowedProtectorIds":[]}`,
		"missing ids":                 `{"lane":"surface","observeLevel":"passive"}`,
		"null ids":                    `{"lane":"surface","observeLevel":"passive","escrowedProtectorIds":null}`,
		"missing level":               `{"lane":"surface","escrowedProtectorIds":[]}`,
		"missing lane":                `{"observeLevel":"passive","escrowedProtectorIds":[]}`,
		"braced id":                   `{"lane":"surface","observeLevel":"passive","escrowedProtectorIds":["{3c6c3b5e-0d1e-4a3e-9d0a-6f2f8c1b2a11}"]}`,
		"not a uuid":                  `{"lane":"surface","observeLevel":"passive","escrowedProtectorIds":["abc"]}`,
		"17 ids":                      `{"lane":"surface","observeLevel":"passive","escrowedProtectorIds":[` + strings.Join(many, ",") + `]}`,
		"trailing data":               good + `{}`,
		"array":                       `[]`,
		"lane case":                   `{"lane":"Surface","observeLevel":"passive","escrowedProtectorIds":[]}`,
		"duplicate key, last is dell": `{"lane":"surface","lane":"dell","observeLevel":"passive","escrowedProtectorIds":[]}`,
	}
	for name, payload := range bad {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseRequest([]byte(payload)); err == nil {
				t.Fatalf("payload accepted: %s", payload)
			}
		})
	}
}

func TestCleanText(t *testing.T) {
	cases := []struct {
		in   string
		max  int
		want string
	}{
		{"  plain  ", 64, "plain"},
		{"a\x00b\x1fc\x7fd\ne", 64, "abcde"},
		{"abcdef", 3, "abc"},
		// A surrogate pair is never split: three UTF-16 units do not fit "a" plus
		// a pair plus anything after.
		{"a\U0001F600b", 2, "a"},
		{"a\U0001F600b", 3, "a\U0001F600"},
		{"bad\xffutf8", 64, "bad\uFFFDutf8"},
	}
	for _, c := range cases {
		if got := cleanText(c.in, c.max); got != c.want {
			t.Errorf("cleanText(%q, %d) = %q, want %q", c.in, c.max, got, c.want)
		}
	}
	if optText("\x00 \x01", 10) != nil {
		t.Error("a string that cleans to empty must be null")
	}
}

func TestNormalizeBIOSDate(t *testing.T) {
	cases := map[string]string{
		"08/14/2026": "2026-08-14",
		"8/4/2026":   "2026-08-04",
		"2026-08-14": "",
		"13/01/2026": "",
		"02/30/2026": "",
		"":           "",
		"garbage":    "",
	}
	for in, want := range cases {
		got := normalizeBIOSDate(in)
		if (want == "" && got != nil) || (want != "" && (got == nil || *got != want)) {
			t.Errorf("normalizeBIOSDate(%q) = %v, want %q", in, got, want)
		}
	}
}

// TestBoundsTruncate: every list is cut to its bound with truncated set, every
// string to its bound, and the result stays under 32 KiB even when 50 updates
// carry maximum-length text.
func TestBoundsTruncate(t *testing.T) {
	long := strings.Repeat("x", 500)
	r := newResult(LaneSurface, "0.131.0")
	for range 20 {
		r.Tools = append(r.Tools, Tool{Name: ToolHPIA, Version: new(long), Location: LocationAgentDir})
	}
	for range 10 {
		r.Conflicts = append(r.Conflicts, Conflict{Name: ConflictHPSupportAssistant, Version: new(long)})
	}
	for range 20 {
		r.addError("bitlocker", "preflight_unknown")
	}
	r.SMBIOS.Manufacturer = new(long)
	r.SMBIOS.BaseboardProduct = new(long)
	for i := range 80 {
		r.Surface.Updates = append(r.Surface.Updates, SurfaceUpdate{
			Title:              long,
			UpdateID:           long + string(rune('a'+i%26)),
			DriverManufacturer: new(long),
			DriverClass:        new(long),
			DriverModel:        new(long),
			DriverProvider:     new(long),
			LaneWouldSelect:    SelectNone,
		})
	}
	Bound(&r)
	if !r.Truncated {
		t.Fatal("truncated not set")
	}
	if len(r.Tools) > maxTools || len(r.Conflicts) > maxConflicts || len(r.Errors) > maxErrors || len(r.Surface.Updates) > maxSurfaceUpdates {
		t.Fatalf("a list is over its bound: tools %d conflicts %d errors %d updates %d", len(r.Tools), len(r.Conflicts), len(r.Errors), len(r.Surface.Updates))
	}
	if n := len([]rune(*r.SMBIOS.Manufacturer)); n != 64 {
		t.Fatalf("manufacturer is %d long, want 64", n)
	}
	if n := len([]rune(*r.SMBIOS.BaseboardProduct)); n != 32 {
		t.Fatalf("baseboard is %d long, want 32", n)
	}
	out, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) > MaxResultBytes {
		t.Fatalf("result is %d bytes, over %d", len(out), MaxResultBytes)
	}
	if len(r.Surface.Updates) == 0 {
		t.Fatal("the size cut dropped every update; it should drop only the tail")
	}
	if err := decodeStrict(t, out).Validate(); err != nil {
		t.Fatalf("bounded result fails the contract: %v", err)
	}
}

func TestBoundsLenovoCategoriesAndInvalidFields(t *testing.T) {
	r := newResult(LaneLenovo, "0.131.0")
	cat := &LenovoCatalog{Status: new(200), Windows: new("11")}
	for i := range 40 {
		cat.Categories = append(cat.Categories, Category{Name: strings.Repeat("c", 200) + string(rune('a'+i%26)), Count: 1})
	}
	r.Lenovo.Catalog = cat
	r.Lenovo.MachineType = new("21k5")
	r.BIOS.ReleaseDate = new("08/14/2026")
	Bound(&r)
	if len(r.Lenovo.Catalog.Categories) != maxCategories || !r.Truncated {
		t.Fatalf("categories %d truncated %v", len(r.Lenovo.Catalog.Categories), r.Truncated)
	}
	if n := len([]rune(r.Lenovo.Catalog.Categories[0].Name)); n != 96 {
		t.Fatalf("category name is %d long, want 96", n)
	}
	if r.Lenovo.MachineType != nil {
		t.Fatal("a machine type outside ^[A-Z0-9]{4}$ must be dropped to null")
	}
	if r.BIOS.ReleaseDate != nil {
		t.Fatal("a release date that is not YYYY-MM-DD must be dropped to null")
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestErrorEntriesAreIdentifiersOnly(t *testing.T) {
	r := newResult(LaneHP, "0.131.0")
	r.addError("bitlocker", "access denied: C:\\Users\\alice")
	r.addError("", "x")
	r.addError("hp_catalog", "network_error")
	Bound(&r)
	if len(r.Errors) != 1 || r.Errors[0].Code != "network_error" {
		t.Fatalf("errors = %+v, want only the identifier entry", r.Errors)
	}
}

func TestAgentVersionFallback(t *testing.T) {
	r := newResult(LaneHP, "")
	Bound(&r)
	if r.AgentVersion == "" {
		t.Fatal("agentVersion must not be empty (schema min 1)")
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
}
