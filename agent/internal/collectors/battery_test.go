package collectors

import "testing"

func pctOf(b *BatteryInfo) float64 {
	if b == nil || b.Percent == nil {
		return -1
	}
	return *b.Percent
}

func TestMapWindowsPowerStatus(t *testing.T) {
	tests := []struct {
		name          string
		acLine        byte
		batteryFlag   byte
		lifePercent   byte
		lifeTime      uint32
		wantPresent   bool
		wantPercent   float64
		wantState     string
		wantPlugged   *bool
		wantRemaining *int
	}{
		{
			name:        "desktop no battery",
			acLine:      1,
			batteryFlag: 0x80, // 128 = no system battery
			lifePercent: 255,
			lifeTime:    0xFFFFFFFF,
			wantPresent: false,
			wantPercent: -1,
			wantState:   "",
			wantPlugged: boolPtr(true),
		},
		{
			name:          "on battery discharging with estimate",
			acLine:        0,
			batteryFlag:   0x01, // high, not charging
			lifePercent:   85,
			lifeTime:      9000, // 150 min
			wantPresent:   true,
			wantPercent:   85,
			wantState:     batteryStateDischarging,
			wantPlugged:   boolPtr(false),
			wantRemaining: intPtr(150),
		},
		{
			name:        "charging on AC",
			acLine:      1,
			batteryFlag: 0x08, // charging
			lifePercent: 50,
			lifeTime:    0xFFFFFFFF,
			wantPresent: true,
			wantPercent: 50,
			wantState:   batteryStateCharging,
			wantPlugged: boolPtr(true),
		},
		{
			name:        "full on AC at 100",
			acLine:      1,
			batteryFlag: 0x01, // high, not charging bit
			lifePercent: 100,
			lifeTime:    0xFFFFFFFF,
			wantPresent: true,
			wantPercent: 100,
			wantState:   batteryStateFull,
			wantPlugged: boolPtr(true),
		},
		{
			name:        "plugged in not charging below full",
			acLine:      1,
			batteryFlag: 0x01,
			lifePercent: 80,
			lifeTime:    0xFFFFFFFF,
			wantPresent: true,
			wantPercent: 80,
			wantState:   batteryStateNotCharging,
			wantPlugged: boolPtr(true),
		},
		{
			name:        "unknown ac line",
			acLine:      255,
			batteryFlag: 0x01,
			lifePercent: 60,
			lifeTime:    0xFFFFFFFF,
			wantPresent: true,
			wantPercent: 60,
			wantState:   batteryStateUnknown,
			wantPlugged: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := mapWindowsPowerStatus(tt.acLine, tt.batteryFlag, tt.lifePercent, tt.lifeTime)
			if got == nil {
				t.Fatal("got nil")
			}
			if got.Present != tt.wantPresent {
				t.Errorf("Present = %v, want %v", got.Present, tt.wantPresent)
			}
			if pctOf(got) != tt.wantPercent {
				t.Errorf("Percent = %v, want %v", pctOf(got), tt.wantPercent)
			}
			if got.ChargingState != tt.wantState {
				t.Errorf("ChargingState = %q, want %q", got.ChargingState, tt.wantState)
			}
			if !eqBoolPtr(got.PluggedIn, tt.wantPlugged) {
				t.Errorf("PluggedIn = %v, want %v", derefBool(got.PluggedIn), derefBool(tt.wantPlugged))
			}
			if !eqIntPtr(got.TimeRemainingMinutes, tt.wantRemaining) {
				t.Errorf("TimeRemainingMinutes = %v, want %v", derefInt(got.TimeRemainingMinutes), derefInt(tt.wantRemaining))
			}
		})
	}
}

func TestParsePmsetBatt(t *testing.T) {
	t.Run("discharging on battery", func(t *testing.T) {
		out := "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4849763)\t85%; discharging; 2:30 remaining present: true\n"
		b := parsePmsetBatt(out)
		if b == nil || !b.Present {
			t.Fatalf("expected present battery, got %+v", b)
		}
		if pctOf(b) != 85 {
			t.Errorf("percent = %v, want 85", pctOf(b))
		}
		if b.ChargingState != batteryStateDischarging {
			t.Errorf("state = %q, want discharging", b.ChargingState)
		}
		if !eqBoolPtr(b.PluggedIn, boolPtr(false)) {
			t.Errorf("pluggedIn = %v, want false", derefBool(b.PluggedIn))
		}
		if !eqIntPtr(b.TimeRemainingMinutes, intPtr(150)) {
			t.Errorf("remaining = %v, want 150", derefInt(b.TimeRemainingMinutes))
		}
	})

	t.Run("charging on AC maps time-to-full", func(t *testing.T) {
		out := "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4849763)\t50%; charging; 1:15 remaining present: true\n"
		b := parsePmsetBatt(out)
		if b == nil || b.ChargingState != batteryStateCharging {
			t.Fatalf("expected charging, got %+v", b)
		}
		if !eqBoolPtr(b.PluggedIn, boolPtr(true)) {
			t.Errorf("pluggedIn = %v, want true", derefBool(b.PluggedIn))
		}
		if !eqIntPtr(b.TimeToFullMinutes, intPtr(75)) {
			t.Errorf("timeToFull = %v, want 75", derefInt(b.TimeToFullMinutes))
		}
		if b.TimeRemainingMinutes != nil {
			t.Errorf("timeRemaining should be nil while charging, got %v", *b.TimeRemainingMinutes)
		}
	})

	t.Run("charged full", func(t *testing.T) {
		out := "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4849763)\t100%; charged; 0:00 remaining present: true\n"
		b := parsePmsetBatt(out)
		if b == nil || b.ChargingState != batteryStateFull {
			t.Fatalf("expected full, got %+v", b)
		}
		if b.TimeRemainingMinutes != nil || b.TimeToFullMinutes != nil {
			t.Errorf("no time estimates expected at 0:00, got remaining=%v tofull=%v", b.TimeRemainingMinutes, b.TimeToFullMinutes)
		}
	})

	t.Run("desktop no battery line", func(t *testing.T) {
		out := "Now drawing from 'AC Power'\n"
		b := parsePmsetBatt(out)
		if b == nil || b.Present {
			t.Fatalf("expected present=false, got %+v", b)
		}
		if !eqBoolPtr(b.PluggedIn, boolPtr(true)) {
			t.Errorf("pluggedIn = %v, want true", derefBool(b.PluggedIn))
		}
	})

	t.Run("no estimate omits time", func(t *testing.T) {
		out := "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4849763)\t72%; discharging; (no estimate) present: true\n"
		b := parsePmsetBatt(out)
		if b == nil || b.TimeRemainingMinutes != nil {
			t.Fatalf("expected no time estimate, got %+v", b)
		}
	})
}

func TestNormalizeLinuxChargingState(t *testing.T) {
	cases := map[string]string{
		"Charging":     batteryStateCharging,
		"Discharging":  batteryStateDischarging,
		"Full":         batteryStateFull,
		"Not charging": batteryStateNotCharging,
		"Unknown":      batteryStateUnknown,
		"garbage":      batteryStateUnknown,
	}
	for in, want := range cases {
		if got := normalizeLinuxChargingState(in); got != want {
			t.Errorf("normalizeLinuxChargingState(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLinuxMinutesFromEnergy(t *testing.T) {
	// 50 Wh reservoir draining at 25 W → 2h = 120 min.
	if got := linuxMinutesFromEnergy(50_000_000, 25_000_000); got == nil || *got != 120 {
		t.Errorf("expected 120 min, got %v", derefInt(got))
	}
	// Zero rate (idle) → nil.
	if got := linuxMinutesFromEnergy(50_000_000, 0); got != nil {
		t.Errorf("expected nil for zero rate, got %v", *got)
	}
}

// --- ptr comparison helpers ---

func eqBoolPtr(a, b *bool) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func eqIntPtr(a, b *int) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func derefBool(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}

func derefInt(i *int) any {
	if i == nil {
		return nil
	}
	return *i
}
