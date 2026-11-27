package promptkinds

import (
	"testing"
	"time"
)

// #12794: the host keeps a seen notice off the next renderer only when the
// prompt's kind says it is informational. Every notice the agent builds
// carries that flag; no kind that asks the person to decide does.
func TestOnlyNoticesAreInformational(t *testing.T) {
	for _, k := range Specs() {
		if want := k.Name == "notice.info"; k.Informational != want {
			t.Errorf("%s: Informational = %v, want %v", k.Name, k.Informational, want)
		}
	}
	n := Notices{Now: func() time.Time { return testNow }}
	for name, p := range map[string]bool{
		"safe mode":     n.SafeModeRebootNotice(5*time.Minute, testNow).Kind.Informational,
		"permissions":   n.MacPermissionNotice([]string{PermissionFullDiskAccess}).Kind.Informational,
		"session ended": n.RemoteSessionEndedNotice("sess-1", 3*time.Minute, "Alex").Kind.Informational,
	} {
		if !p {
			t.Errorf("%s notice is not informational", name)
		}
	}
}
