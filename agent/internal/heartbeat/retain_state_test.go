package heartbeat

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/tunnel"
)

func decodeRetain(t *testing.T, raw string) RetainState {
	t.Helper()
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"commands":[{"id":"c1","type":"noop"}],"retainState":`+raw+`}`), &resp); err != nil {
		t.Fatalf("response decode must never fail on retainState %s: %v", raw, err)
	}
	if len(resp.Commands) != 1 || resp.Commands[0].ID != "c1" {
		t.Fatalf("a malformed retainState must not cost the beat its commands: %+v", resp.Commands)
	}
	return resp.RetainState
}

func TestRetainStateDecode(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want RetainState
	}{
		{"all", `["pam","helper","remoteManagement"]`, RetainState{PAM: true, Helper: true, RemoteManagement: true}},
		{"pam only", `["pam"]`, RetainState{PAM: true}},
		{"empty array", `[]`, RetainState{}},
		{"unknown names ignored", `["pam","futureThing"]`, RetainState{PAM: true}},
		{"mixed scalars keep valid strings", `["helper",7,null,true,"pam"]`, RetainState{Helper: true, PAM: true}},
		{"nested object stops parsing", `["helper",{"a":1},"pam"]`, RetainState{Helper: true}},
		{"nested array stops parsing", `["helper",["pam"],"remoteManagement"]`, RetainState{Helper: true}},
		{"object is empty", `{"pam":true}`, RetainState{}},
		{"number is empty", `3`, RetainState{}},
		{"string is empty", `"pam"`, RetainState{}},
		{"bool is empty", `true`, RetainState{}},
		{"null is empty", `null`, RetainState{}},
		{"case sensitive", `["PAM","Helper","remotemanagement"]`, RetainState{}},
		{"oversized entry ignored", `["` + strings.Repeat("a", 4096) + `","pam"]`, RetainState{PAM: true}},
		{"oversized known-prefix entry ignored", `["pam` + strings.Repeat(" ", 64) + `"]`, RetainState{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decodeRetain(t, tc.raw); got != tc.want {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
}

func TestRetainStateDecodeBoundsEntries(t *testing.T) {
	// "pam" past the 16-entry cap must not be honoured, however long the array.
	raw := "[" + strings.Repeat(`"x",`, 5000) + `"pam"]`
	if got := decodeRetain(t, raw); got.PAM {
		t.Fatal("entries beyond the cap must be ignored")
	}
	// The 16th entry is still inside the cap.
	raw = "[" + strings.Repeat(`"x",`, retainStateMaxEntries-1) + `"pam"]`
	if got := decodeRetain(t, raw); !got.PAM {
		t.Fatal("an entry inside the cap must be honoured")
	}
}

func TestRetainStateAbsentIsZero(t *testing.T) {
	var resp HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"commands":[]}`), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.RetainState != (RetainState{}) {
		t.Fatalf("absent retainState must be the zero value, got %+v", resp.RetainState)
	}
}

// The heartbeat response is decoded with json.NewDecoder in production; make
// sure a malformed retainState is tolerated through that path too.
func TestRetainStateDecoderPathTolerant(t *testing.T) {
	var resp HeartbeatResponse
	body := `{"commands":[],"retainState":{"x":[1,2,{"y":"z"}]},"upgradeTo":"9.9.9"}`
	if err := json.NewDecoder(strings.NewReader(body)).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.UpgradeTo != "9.9.9" || resp.RetainState != (RetainState{}) {
		t.Fatalf("unexpected decode: upgradeTo=%q retain=%+v", resp.UpgradeTo, resp.RetainState)
	}
}

// newPamReadyTestHeartbeat returns a heartbeat whose PAM lifecycle is
// reconciled and verified (so handleUACInterception(true) can enable) but NOT
// enabled, with a tunnel manager (every apply path dereferences tunnelMgr).
func newPamReadyTestHeartbeat(t *testing.T) (*Heartbeat, *fakePamLifetimeManager) {
	t.Helper()
	fake := &fakePamLifetimeManager{available: true}
	h := newPamControllerTestHeartbeat(t, fake)
	h.pamReconciled.Store(true)
	h.pamVerificationAvailable.Store(true)
	h.tunnelMgr = tunnel.NewManager(false)
	return h, fake
}

func newRetainTestHeartbeat() *Heartbeat {
	return &Heartbeat{tunnelMgr: tunnel.NewManager(false)}
}

func countSetEnabled(fake *fakePamLifetimeManager, enabled bool) int {
	n := 0
	for _, v := range fake.setEnabledCalls {
		if v == enabled {
			n++
		}
	}
	return n
}

func enablePAM(t *testing.T, h *Heartbeat) {
	t.Helper()
	h.handleUACInterception(boolPtr(true))
	if !h.IsUACInterceptionEnabled() {
		t.Fatal("precondition: PAM enabled")
	}
}

func TestRetainStatePAMKeepsEnabledState(t *testing.T) {
	h, _ := newPamReadyTestHeartbeat(t)
	enablePAM(t, h)
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true}})
	if !h.IsUACInterceptionEnabled() {
		t.Fatal("retain must keep PAM enabled; an absent value without retain disables it")
	}
}

func TestRetainStatePAMWhileOnDoesNotTouchLifetimeManager(t *testing.T) {
	h, fake := newPamReadyTestHeartbeat(t)
	enablePAM(t, h)
	before := len(fake.setEnabledCalls)
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true}, UacInterceptionEnabled: boolPtr(false)})
	if len(fake.setEnabledCalls) != before || !h.IsUACInterceptionEnabled() {
		t.Fatalf("retain while enabled must leave PAM and the lifetime manager untouched (stray legacy false ignored); calls=%v", fake.setEnabledCalls)
	}
}

func TestRetainStatePAMIgnoresStrayLegacyTrue(t *testing.T) {
	h, fake := newPamReadyTestHeartbeat(t)
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true}, UacInterceptionEnabled: boolPtr(true)})
	if h.IsUACInterceptionEnabled() {
		t.Fatal("retain wins: a retained feature's legacy value must be ignored")
	}
	if n := countSetEnabled(fake, true); n != 0 {
		t.Fatalf("retain must never enable, got %d SetEnabled(true)", n)
	}
}

func TestRetainStatePAMExplicitFalseStillDisables(t *testing.T) {
	h, fake := newPamReadyTestHeartbeat(t)
	enablePAM(t, h)
	h.applySettingsDecisions(&HeartbeatResponse{UacInterceptionEnabled: boolPtr(false)}) // PAM not retained
	if h.IsUACInterceptionEnabled() {
		t.Fatal("a decided false must still disable PAM")
	}
	if countSetEnabled(fake, false) == 0 {
		t.Fatal("a decided false must run the disable/cleanup path")
	}
}

func TestRetainStatePAMExplicitTrueStillEnables(t *testing.T) {
	h, _ := newPamReadyTestHeartbeat(t)
	h.applySettingsDecisions(&HeartbeatResponse{UacInterceptionEnabled: boolPtr(true), RetainState: RetainState{Helper: true}})
	if !h.IsUACInterceptionEnabled() {
		t.Fatal("retaining another feature must not stop a decided PAM true from applying")
	}
}

// Boot state / failed-cleanup state: PAM is off. Retain must keep the
// idempotent disable (cleanup retry) running every beat, exactly as an absent
// value does today, and must never call SetEnabled(true).
func TestRetainStatePAMWhileOffKeepsRetryingDisableNeverEnables(t *testing.T) {
	h, fake := newPamReadyTestHeartbeat(t)
	for i := 0; i < 3; i++ {
		h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true}, UacInterceptionEnabled: boolPtr(true)})
	}
	if n := countSetEnabled(fake, true); n != 0 {
		t.Fatalf("retain must never enable, got %d SetEnabled(true)", n)
	}
	if n := countSetEnabled(fake, false); n != 3 {
		t.Fatalf("while off, retain must run the disable/cleanup path every beat, got %d of 3", n)
	}
	if h.IsUACInterceptionEnabled() {
		t.Fatal("boot default stays off")
	}
}

// A disable whose cleanup failed leaves PAM off with verification
// unavailable; a retained beat must retry the cleanup rather than freeze it.
func TestRetainStatePAMRetriesFailedDisableCleanup(t *testing.T) {
	h, fake := newPamReadyTestHeartbeat(t)
	enablePAM(t, h)
	fake.setEnabledErr = errors.New("cleanup not verified")
	h.applySettingsDecisions(&HeartbeatResponse{UacInterceptionEnabled: boolPtr(false)})
	if h.IsUACInterceptionEnabled() || h.pamVerificationAvailable.Load() {
		t.Fatal("precondition: disable flipped PAM off and marked verification unavailable")
	}
	fake.setEnabledErr = nil
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true}})
	if !h.pamVerificationAvailable.Load() {
		t.Fatal("a retained beat while PAM is off must retry the disable cleanup and restore verification")
	}
	if n := countSetEnabled(fake, true); n != 1 { // only the enablePAM precondition
		t.Fatalf("retain must never enable, got %d SetEnabled(true)", n)
	}
}

func TestRetainStateHelperKeepsFlagAndSkipsSettings(t *testing.T) {
	h := newRetainTestHeartbeat()
	lc := &fakeLifecycle{}
	h.helperLifecycle = lc
	h.handleHelperEnabled(true)
	// helperMgr is nil: applying the stray settings would panic, so this also
	// proves helperMgr.Apply is skipped for a retained helper.
	h.applySettingsDecisions(&HeartbeatResponse{
		RetainState:    RetainState{Helper: true},
		HelperSettings: &HelperSettings{Enabled: false, LifecycleMode: "on-demand"},
	})
	if !h.IsHelperEnabled() {
		t.Fatal("retain must keep the helper flag")
	}
	if len(lc.modeOverrides) != 0 {
		t.Fatalf("retain must not touch the helper lifecycle, got overrides %v", lc.modeOverrides)
	}
}

func TestRetainStateRemoteManagementKeepsPolicyFlag(t *testing.T) {
	h := newRetainTestHeartbeat()
	h.tunnelMgr.SetManagedByPolicy(true)
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{RemoteManagement: true}})
	if !h.tunnelMgr.IsManagedByPolicy() {
		t.Fatal("retain must keep managedByPolicy")
	}
}

func TestRetainStateRemoteManagementDecidedStillApplies(t *testing.T) {
	h := newRetainTestHeartbeat()
	h.applySettingsDecisions(&HeartbeatResponse{ManageRemoteManagement: true, RetainState: RetainState{PAM: true, Helper: true}})
	if !h.tunnelMgr.IsManagedByPolicy() {
		t.Fatal("a decided remoteManagement must apply while other features are retained")
	}
}

// Old-API compatibility: a response with no retainState must behave exactly
// as before — absent PAM disables and runs cleanup, an absent helper flag and
// remote-management flag turn off.
func TestLegacyShapeUnchangedWithoutRetainState(t *testing.T) {
	h, fake := newPamReadyTestHeartbeat(t)
	enablePAM(t, h)
	h.tunnelMgr.SetManagedByPolicy(true)
	h.handleHelperEnabled(true)
	disablesBefore := countSetEnabled(fake, false)
	h.applySettingsDecisions(&HeartbeatResponse{})
	if h.IsUACInterceptionEnabled() || h.tunnelMgr.IsManagedByPolicy() || h.IsHelperEnabled() {
		t.Fatal("without retainState the legacy semantics (absent = off) must be preserved")
	}
	if countSetEnabled(fake, false) != disablesBefore+1 {
		t.Fatal("absent PAM must still run the disable/cleanup path exactly once")
	}
}

// The full response pipeline also honours retain (not only the test wrapper).
func TestProcessHeartbeatResponseHonoursRetainState(t *testing.T) {
	h, fake := newPamReadyTestHeartbeat(t)
	enablePAM(t, h)
	h.tunnelMgr.SetManagedByPolicy(true)
	h.handleHelperEnabled(true)
	before := len(fake.setEnabledCalls)
	h.processHeartbeatResponse(&HeartbeatResponse{RetainState: RetainState{PAM: true, Helper: true, RemoteManagement: true}})
	if !h.IsUACInterceptionEnabled() || !h.tunnelMgr.IsManagedByPolicy() || !h.IsHelperEnabled() || len(fake.setEnabledCalls) != before {
		t.Fatal("processHeartbeatResponse must keep every retained feature unchanged")
	}
	h.processHeartbeatResponse(&HeartbeatResponse{})
	if h.IsUACInterceptionEnabled() || h.tunnelMgr.IsManagedByPolicy() || h.IsHelperEnabled() {
		t.Fatal("processHeartbeatResponse without retainState must keep legacy semantics")
	}
}

func captureRetainStreakWarnings(t *testing.T) *[]string {
	t.Helper()
	var got []string
	old := logRetainStreakWarning
	logRetainStreakWarning = func(feature string, beats int64) { got = append(got, feature) }
	t.Cleanup(func() { logRetainStreakWarning = old })
	return &got
}

func TestRetainStreakWarnsOncePerStreak(t *testing.T) {
	got := captureRetainStreakWarnings(t)
	h := newRetainTestHeartbeat()
	beat := &HeartbeatResponse{RetainState: RetainState{RemoteManagement: true}}
	for i := 0; i < retainStreakWarnBeats-1; i++ {
		h.applySettingsDecisions(beat)
	}
	if len(*got) != 0 {
		t.Fatalf("no warning before %d consecutive retained beats, got %v", retainStreakWarnBeats, *got)
	}
	h.applySettingsDecisions(beat)
	if len(*got) != 1 || (*got)[0] != "remoteManagement" {
		t.Fatalf("want exactly one remoteManagement warning at beat %d, got %v", retainStreakWarnBeats, *got)
	}
	for i := 0; i < 2*retainStreakWarnBeats; i++ {
		h.applySettingsDecisions(beat)
	}
	if len(*got) != 1 {
		t.Fatalf("one warning per streak, got %v", *got)
	}
}

func TestRetainStreakResetsOnDecidedBeatAndIsPerFeature(t *testing.T) {
	got := captureRetainStreakWarnings(t)
	h := newRetainTestHeartbeat()
	for i := 0; i < retainStreakWarnBeats-1; i++ {
		h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{RemoteManagement: true}})
	}
	// A beat that decides remoteManagement (helper retained) resets the
	// remoteManagement streak only: remoteManagement=0, helper=1.
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{Helper: true}})
	for i := 0; i < retainStreakWarnBeats-2; i++ {
		h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{RemoteManagement: true, Helper: true}})
	}
	// remoteManagement=threshold-2, helper=threshold-1.
	if len(*got) != 0 {
		t.Fatalf("a decided beat must reset that feature's streak, got %v", *got)
	}
	// Helper decided here (reset), remoteManagement reaches threshold-1.
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{RemoteManagement: true}})
	if len(*got) != 0 {
		t.Fatalf("no feature at the threshold yet, got %v", *got)
	}
	h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{RemoteManagement: true}})
	if len(*got) != 1 || (*got)[0] != "remoteManagement" {
		t.Fatalf("remoteManagement reaches the threshold after its reset, got %v", *got)
	}
	// After a decided beat, a new streak warns again.
	h.applySettingsDecisions(&HeartbeatResponse{})
	for i := 0; i < retainStreakWarnBeats; i++ {
		h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{RemoteManagement: true}})
	}
	if len(*got) != 2 {
		t.Fatalf("a new streak after a decided beat warns again, got %v", *got)
	}
}

func TestRetainStreakCountsEachFeature(t *testing.T) {
	got := captureRetainStreakWarnings(t)
	h, _ := newPamReadyTestHeartbeat(t)
	for i := 0; i < retainStreakWarnBeats; i++ {
		h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true, Helper: true, RemoteManagement: true}})
	}
	want := map[string]bool{"pam": true, "helper": true, "remoteManagement": true}
	if len(*got) != 3 {
		t.Fatalf("want one warning per feature, got %v", *got)
	}
	for _, f := range *got {
		if !want[f] {
			t.Fatalf("unexpected feature %q in %v", f, *got)
		}
		delete(want, f)
	}
}

// The streak is log-only: a long retain never reverts the retained state.
func TestRetainStreakNeverRevertsState(t *testing.T) {
	captureRetainStreakWarnings(t)
	h, fake := newPamReadyTestHeartbeat(t)
	enablePAM(t, h)
	before := len(fake.setEnabledCalls)
	for i := 0; i < 3*retainStreakWarnBeats; i++ {
		h.applySettingsDecisions(&HeartbeatResponse{RetainState: RetainState{PAM: true}})
	}
	if !h.IsUACInterceptionEnabled() || len(fake.setEnabledCalls) != before {
		t.Fatal("a retain streak must never revert PAM")
	}
}
