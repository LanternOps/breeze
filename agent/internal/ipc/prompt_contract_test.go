package ipc

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// promptFixtureDir is the golden fixture set shared with the TS schema and
// the Rust Assist suite (packages/shared/src/fixtures/prompt-host).
var promptFixtureDir = filepath.Join("..", "..", "..", "packages", "shared", "src", "fixtures", "prompt-host")

func readPromptFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(promptFixtureDir, name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

// canonicalJSON re-encodes arbitrary JSON with sorted object keys.
func canonicalJSON(t *testing.T, raw []byte) string {
	t.Helper()
	var v any
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("decode: %v", err)
	}
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return string(out)
}

// promptFixtureTarget maps a fixture to the Go type that must round-trip it.
// Fixtures that are not IPC payloads are listed with a nil constructor so a
// new fixture can never be skipped silently.
func promptFixtureTarget(name string) (newTarget func() any, handled bool) {
	switch {
	case strings.HasPrefix(name, "show."):
		return func() any { return &PromptShow{} }, true
	case strings.HasPrefix(name, "update."):
		return func() any { return &PromptUpdate{} }, true
	case strings.HasPrefix(name, "close."):
		return func() any { return &PromptClose{} }, true
	case name == "presented.json":
		return func() any { return &PromptPresented{} }, true
	case name == "action.json":
		return func() any { return &PromptActionRequest{} }, true
	case strings.HasPrefix(name, "action_result."):
		return func() any { return &PromptActionResult{} }, true
	case strings.HasPrefix(name, "closed."):
		return func() any { return &PromptClosed{} }, true
	case strings.HasPrefix(name, "branding_sync."):
		return func() any { return &PromptBrandingSync{} }, true
	case strings.HasPrefix(name, "auth."):
		return func() any { return &AuthRequest{} }, true
	case strings.HasPrefix(name, "heartbeat.prompt_host"), name == "skew-matrix.json":
		// Heartbeat shapes round-trip in the heartbeat package; the skew
		// matrix drives prompthost selection tests.
		return nil, true
	}
	return nil, false
}

func TestPromptFixturesRoundTrip(t *testing.T) {
	entries, err := os.ReadDir(promptFixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}
	ipcFixtures := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		newTarget, handled := promptFixtureTarget(name)
		if !handled {
			t.Errorf("fixture %s has no Go round-trip target; map it in promptFixtureTarget", name)
			continue
		}
		if newTarget == nil {
			continue
		}
		ipcFixtures++
		t.Run(name, func(t *testing.T) {
			raw := readPromptFixture(t, name)
			target := newTarget()
			if err := json.Unmarshal(raw, target); err != nil {
				t.Fatalf("decode into %T: %v", target, err)
			}
			reencoded, err := json.Marshal(target)
			if err != nil {
				t.Fatalf("encode %T: %v", target, err)
			}
			if got, want := canonicalJSON(t, reencoded), canonicalJSON(t, raw); got != want {
				t.Fatalf("round trip changed the payload\n got: %s\nwant: %s", got, want)
			}
		})
	}
	if ipcFixtures < 14 {
		t.Fatalf("only %d IPC fixtures round-tripped; the fixture set is incomplete", ipcFixtures)
	}
}

func TestPromptShowFixturesValidate(t *testing.T) {
	for _, name := range []string{"show.notice.json", "show.restart.json", "show.elevation.waiting.json"} {
		var show PromptShow
		if err := json.Unmarshal(readPromptFixture(t, name), &show); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := ValidatePromptShow(show); err != nil {
			t.Fatalf("%s: ValidatePromptShow = %v, want nil", name, err)
		}
	}
}

func TestValidatePromptShowRefuses(t *testing.T) {
	base := func(t *testing.T) PromptShow {
		var show PromptShow
		if err := json.Unmarshal(readPromptFixture(t, "show.restart.json"), &show); err != nil {
			t.Fatal(err)
		}
		return show
	}
	notice := func(t *testing.T) PromptShow {
		var show PromptShow
		if err := json.Unmarshal(readPromptFixture(t, "show.notice.json"), &show); err != nil {
			t.Fatal(err)
		}
		return show
	}
	cases := []struct {
		name   string
		mutate func(t *testing.T) PromptShow
		want   string
	}{
		{"no safe action", func(t *testing.T) PromptShow {
			s := base(t)
			for i := range s.Actions {
				s.Actions[i].Role = PromptRoleProceed
			}
			return s
		}, "exactly one safe action"},
		{"two safe actions", func(t *testing.T) PromptShow {
			s := base(t)
			for i := range s.Actions {
				s.Actions[i].Role = PromptRoleSafe
			}
			return s
		}, "exactly one safe action"},
		{"default is not the safe action", func(t *testing.T) PromptShow {
			s := base(t)
			s.DefaultActionID = "restart_now"
			return s
		}, "defaults to its safe action"},
		{"no default on a decision", func(t *testing.T) PromptShow {
			s := base(t)
			s.DefaultActionID = ""
			return s
		}, "defaults to its safe action"},
		{"more than three actions", func(t *testing.T) PromptShow {
			s := base(t)
			s.Actions = append(s.Actions, PromptAction{ID: "a3", Label: "3", Role: PromptRoleNeutral}, PromptAction{ID: "a4", Label: "4", Role: PromptRoleNeutral})
			return s
		}, "at most 3 actions"},
		{"duplicate action ids", func(t *testing.T) PromptShow {
			s := base(t)
			s.Actions[1].ID = s.Actions[0].ID
			return s
		}, "duplicate action id"},
		{"deadline and response window", func(t *testing.T) PromptShow {
			s := base(t)
			s.Timing.ResponseMs = 30000
			return s
		}, "exclusive"},
		{"expiry names no action", func(t *testing.T) PromptShow {
			s := base(t)
			missing := "nope"
			s.Timing.Expiry = &PromptExpiry{ActionID: &missing, Text: "x"}
			return s
		}, "expiry names no action"},
		{"operator note on a breeze kind", func(t *testing.T) PromptShow {
			s := notice(t)
			s.Copy.OperatorNote = "Call 555-0100"
			return s
		}, "operator text on a breeze-class kind"},
		{"operator note on an unknown kind", func(t *testing.T) PromptShow {
			s := notice(t)
			s.Kind = "future.kind"
			s.Copy.OperatorNote = "x"
			return s
		}, "operator text on a breeze-class kind"},
		{"empty title", func(t *testing.T) PromptShow {
			s := base(t)
			s.Copy.Title = ""
			return s
		}, "title"},
		{"random prompt id", func(t *testing.T) PromptShow {
			s := base(t)
			s.PromptID = "7f3c2a10"
			return s
		}, "promptId"},
		{"zero lease epoch", func(t *testing.T) PromptShow {
			s := base(t)
			s.Lease.Epoch = 0
			return s
		}, "lease"},
		{"title over 200 code points", func(t *testing.T) PromptShow {
			s := base(t)
			s.Copy.Title = strings.Repeat("é", 201)
			return s
		}, "title"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePromptShow(tc.mutate(t))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("ValidatePromptShow = %v, want error containing %q", err, tc.want)
			}
		})
	}
	t.Run("200 multibyte code points is within the title cap", func(t *testing.T) {
		s := base(t)
		s.Copy.Title = strings.Repeat("é", 200)
		if err := ValidatePromptShow(s); err != nil {
			t.Fatalf("ValidatePromptShow = %v, want nil (limits count code points)", err)
		}
	})
	t.Run("indicator in pending is not a decision", func(t *testing.T) {
		s := notice(t)
		s.PromptID = "session:00000000-0000-4000-8000-0000000000aa"
		s.Kind = "remote.session"
		s.Presentation = PromptPresentationIndicator
		s.Actions = []PromptAction{{ID: "details", Label: "Details", Role: PromptRoleNeutral}}
		s.DefaultActionID = ""
		if err := ValidatePromptShow(s); err != nil {
			t.Fatalf("ValidatePromptShow = %v, want nil", err)
		}
	})
}

func TestApplyPromptUpdateValidatesMergedState(t *testing.T) {
	var show PromptShow
	if err := json.Unmarshal(readPromptFixture(t, "show.restart.json"), &show); err != nil {
		t.Fatal(err)
	}
	onlyProceed := []PromptAction{{ID: "restart_now", Label: "Restart now", Role: PromptRoleProceed}}
	if _, err := ApplyPromptUpdate(show, PromptUpdate{PromptID: show.PromptID, Rev: 2, Lease: show.Lease, Actions: &onlyProceed}); err == nil {
		t.Fatal("update leaving a pending decision without a safe default was accepted")
	}
	approved := PromptStateApproved
	none := []PromptAction{}
	merged, err := ApplyPromptUpdate(show, PromptUpdate{PromptID: show.PromptID, Rev: 2, Lease: PromptLease{RendererSession: "assist-user-5000", Epoch: 2}, State: &approved, Actions: &none})
	if err != nil {
		t.Fatalf("ApplyPromptUpdate = %v", err)
	}
	if merged.Rev != 2 || merged.State != PromptStateApproved || len(merged.Actions) != 0 || merged.DefaultActionID != "" || merged.Lease.Epoch != 2 {
		t.Fatalf("merged = %+v", merged)
	}
	if merged.Copy != show.Copy {
		t.Fatalf("absent copy must be kept: %+v", merged.Copy)
	}
	if _, err := ApplyPromptUpdate(show, PromptUpdate{PromptID: show.PromptID, Rev: 1, Lease: show.Lease}); err == nil {
		t.Fatal("update with a rev that is not newer was accepted")
	}
	if _, err := ApplyPromptUpdate(show, PromptUpdate{PromptID: "restart:43", Rev: 2, Lease: show.Lease}); err == nil {
		t.Fatal("update for another prompt was accepted")
	}
}

func TestAuthRequestPromptFieldsAreAdditive(t *testing.T) {
	raw, err := json.Marshal(AuthRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"promptProtocolVersion", "promptKinds", "rendererVersion", "uiLocale"} {
		if bytes.Contains(raw, []byte(`"`+key+`"`)) {
			t.Fatalf("zero AuthRequest marshals %q: %s", key, raw)
		}
	}
}

func TestAuthRequestUILocaleRoundTrips(t *testing.T) {
	raw, err := json.Marshal(AuthRequest{ProtocolVersion: 1, UILocale: "fr_CA.UTF-8"})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte(`"uiLocale":"fr_CA.UTF-8"`)) {
		t.Fatalf("uiLocale not on the wire: %s", raw)
	}
	var back AuthRequest
	if err := json.Unmarshal(raw, &back); err != nil || back.UILocale != "fr_CA.UTF-8" {
		t.Fatalf("round trip = %+v %v", back, err)
	}
}

func TestProtocolVersionUnchanged(t *testing.T) {
	if ProtocolVersion != 1 {
		t.Fatalf("ipc.ProtocolVersion = %d; it must stay 1 (the broker rejects a mismatch permanently)", ProtocolVersion)
	}
	if PromptProtocolVersion != 1 {
		t.Fatalf("PromptProtocolVersion = %d, want 1", PromptProtocolVersion)
	}
}

func TestParsePromptKindAd(t *testing.T) {
	cases := []struct {
		in      string
		name    string
		version int
		ok      bool
	}{
		{"notice.info@1", "notice.info", 1, true},
		{"elevation.request@12", "elevation.request", 12, true},
		{"notice.info@999", "notice.info", 999, true},
		{"notice.info", "", 0, false},
		{"notice.info@0", "", 0, false},
		{"notice.info@01", "", 0, false},
		{"notice@1", "", 0, false},
		{"Notice.info@1", "", 0, false},
		{"notice.info@1@2", "", 0, false},
		{"notice.info@1234", "", 0, false},
		{"", "", 0, false},
	}
	for _, tc := range cases {
		name, version, ok := ParsePromptKindAd(tc.in)
		if name != tc.name || version != tc.version || ok != tc.ok {
			t.Errorf("ParsePromptKindAd(%q) = (%q, %d, %v), want (%q, %d, %v)", tc.in, name, version, ok, tc.name, tc.version, tc.ok)
		}
	}
}

// TestPromptKindClassTableMatchesSharedRegistry pins the Go class table to
// the shared TS registry (packages/shared/src/promptHost/kinds.ts).
func TestPromptKindClassTableMatchesSharedRegistry(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "shared", "src", "promptHost", "kinds.ts"))
	if err != nil {
		t.Fatalf("read kinds.ts: %v", err)
	}
	re := regexp.MustCompile(`'([a-z]+(?:\.[a-z_]+)+)':\s*\{\s*copyClass:\s*'(breeze|operator)'`)
	matches := re.FindAllStringSubmatch(string(src), -1)
	if len(matches) == 0 {
		t.Fatal("no kinds parsed from kinds.ts; update the pattern")
	}
	shared := map[string]PromptCopyClass{}
	for _, m := range matches {
		shared[m[1]] = PromptCopyClass(m[2])
	}
	goKinds := PromptKindNames()
	sharedKinds := make([]string, 0, len(shared))
	for k := range shared {
		sharedKinds = append(sharedKinds, k)
	}
	sort.Strings(sharedKinds)
	if strings.Join(goKinds, ",") != strings.Join(sharedKinds, ",") {
		t.Fatalf("Go kinds %v != shared kinds %v", goKinds, sharedKinds)
	}
	for kind, class := range shared {
		got, ok := PromptKindClass(kind)
		if !ok || got != class {
			t.Errorf("PromptKindClass(%q) = (%q, %v), want %q", kind, got, ok, class)
		}
		scope, _ := PromptKindScope(kind)
		wantScope := ScopePrompt
		if class == PromptCopyOperator {
			wantScope = ScopePromptOperator
		}
		if scope != wantScope {
			t.Errorf("PromptKindScope(%q) = %q, want %q", kind, scope, wantScope)
		}
	}
	if _, ok := PromptKindClass("future.kind"); ok {
		t.Error("an unknown kind must not have a class")
	}
}

func TestIsPromptDecision(t *testing.T) {
	cases := []struct {
		state PromptState
		pres  PromptPresentation
		want  bool
	}{
		{PromptStatePending, PromptPresentationCard, true},
		{PromptStatePending, PromptPresentationModal, true},
		{PromptStatePending, PromptPresentationListOnly, true},
		{PromptStatePending, PromptPresentationIndicator, false},
		{PromptStateWaiting, PromptPresentationCard, false},
		{PromptStateApproved, PromptPresentationCard, false},
	}
	for _, tc := range cases {
		if got := IsPromptDecision(tc.state, tc.pres); got != tc.want {
			t.Errorf("IsPromptDecision(%s, %s) = %v, want %v", tc.state, tc.pres, got, tc.want)
		}
	}
}
