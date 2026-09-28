package powerevent

import "testing"

func TestClassify(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		eventType uint32
		wantName  string
		wantKind  Kind
	}{
		{"suspend", 0x0004, "PBT_APMSUSPEND", Suspend},
		{"resume critical (pre-Vista, still defined)", 0x0006, "PBT_APMRESUMECRITICAL", Resume},
		{"resume by user input", 0x0007, "PBT_APMRESUMESUSPEND", Resume},
		{"resume automatic (every wake, incl. unattended)", 0x0012, "PBT_APMRESUMEAUTOMATIC", Resume},
		{"power source change", 0x000A, "PBT_APMPOWERSTATUSCHANGE", Other},
		{"power setting change", 0x8013, "PBT_POWERSETTINGCHANGE", Other},
		{"unknown", 0x1234, "PBT_0x1234", Other},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := Classify(tt.eventType); got != tt.wantKind {
				t.Errorf("Classify(%#x) = %v, want %v", tt.eventType, got, tt.wantKind)
			}
			if got := Name(tt.eventType); got != tt.wantName {
				t.Errorf("Name(%#x) = %q, want %q", tt.eventType, got, tt.wantName)
			}
		})
	}
}
