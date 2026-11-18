package ipc

import (
	"encoding/json"
	"strings"
	"testing"
)

// #10190 W06: allowUserEndSession is additive and omitempty. Absent (an
// older server) means false: no End session action anywhere.
func TestDesktopPromptAllowUserEndSession(t *testing.T) {
	var old DesktopPrompt
	if err := json.Unmarshal([]byte(`{"mode":"notify","consentUnavailableBehavior":"block","consentTimeoutMs":30000,"notifyOnEnd":true,"showIndicator":true}`), &old); err != nil {
		t.Fatal(err)
	}
	if old.AllowUserEndSession {
		t.Fatal("an absent allowUserEndSession must read as false")
	}
	var on DesktopPrompt
	if err := json.Unmarshal([]byte(`{"mode":"notify","showIndicator":true,"allowUserEndSession":true}`), &on); err != nil {
		t.Fatal(err)
	}
	if !on.AllowUserEndSession {
		t.Fatal("allowUserEndSession:true was not decoded")
	}
	raw, _ := json.Marshal(DesktopPrompt{Mode: "notify"})
	if strings.Contains(string(raw), "allowUserEndSession") {
		t.Fatalf("false must be omitted: %s", raw)
	}
	raw, _ = json.Marshal(on)
	if !strings.Contains(string(raw), `"allowUserEndSession":true`) {
		t.Fatalf("true must be sent: %s", raw)
	}
}
