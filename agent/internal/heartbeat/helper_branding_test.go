package heartbeat

import (
	"encoding/json"
	"testing"
)

func TestHelperSettingsBrandingDecode(t *testing.T) {
	var old HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"helperSettings":{"enabled":true,"showOpenPortal":true}}`), &old); err != nil {
		t.Fatal(err)
	}
	if old.HelperSettings.Branding != nil {
		t.Fatal("payload without branding must decode to nil (keep last-known)")
	}

	var set HeartbeatResponse
	body := `{"helperSettings":{"enabled":true,"branding":{"state":"set","scopeId":"abc","values":{"displayName":"Acme IT","primaryColor":"#112233"}}}}`
	if err := json.Unmarshal([]byte(body), &set); err != nil {
		t.Fatal(err)
	}
	b := set.HelperSettings.Branding
	if b == nil || b.State != "set" || b.ScopeID != "abc" || b.Values.DisplayName != "Acme IT" || b.Values.PrimaryColor != "#112233" {
		t.Fatalf("set decoded as %+v", b)
	}

	var cleared HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"helperSettings":{"enabled":true,"branding":{"state":"cleared"}}}`), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.HelperSettings.Branding == nil || cleared.HelperSettings.Branding.State != "cleared" {
		t.Fatalf("cleared decoded as %+v", cleared.HelperSettings.Branding)
	}

	// Explicit null is "absent" (keep last-known); an empty object has no state
	// and is rejected downstream, also keeping the last-known branding.
	var null HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"helperSettings":{"enabled":true,"branding":null}}`), &null); err != nil {
		t.Fatal(err)
	}
	if null.HelperSettings.Branding != nil {
		t.Fatalf("null branding decoded as %+v, want nil", null.HelperSettings.Branding)
	}
	var empty HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"helperSettings":{"enabled":true,"branding":{}}}`), &empty); err != nil {
		t.Fatal(err)
	}
	if e := empty.HelperSettings.Branding; e == nil || e.State != "" {
		t.Fatalf("empty branding decoded as %+v, want non-nil with no state", e)
	}

	// A malformed block must not fail the whole heartbeat response.
	var bad HeartbeatResponse
	if err := json.Unmarshal([]byte(`{"helperSettings":{"enabled":true,"branding":[1,2]}}`), &bad); err != nil {
		t.Fatalf("malformed branding failed the response decode: %v", err)
	}
}

func TestHelperSettingsOmitsBrandingWhenNil(t *testing.T) {
	out, err := json.Marshal(HelperSettings{Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"enabled":true,"showOpenPortal":false,"showDeviceInfo":false,"showRequestSupport":false}` {
		t.Fatalf("unbranded settings JSON changed: %s", out)
	}
}

// A retained helper beat skips Apply, so branding in it is not applied either
// (helperMgr is nil: applying would panic).
func TestRetainStateHelperSkipsBranding(t *testing.T) {
	h := newRetainTestHeartbeat()
	var resp HeartbeatResponse
	body := `{"helperSettings":{"enabled":true,"branding":{"state":"cleared"}}}`
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatal(err)
	}

	// Control: without retain-state the beat reaches helperMgr.Apply, which
	// panics here because helperMgr is nil. This proves the retained case below
	// passing means Apply was skipped, not that the harness cannot detect it.
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("control: a non-retained beat should have reached helperMgr.Apply")
			}
		}()
		h.applySettingsDecisions(&resp)
	}()

	resp.RetainState = RetainState{Helper: true}
	h.applySettingsDecisions(&resp)
}
