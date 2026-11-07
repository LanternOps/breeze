package oemupdates

import "testing"

// Review Focus 2: a desktop with no battery must pass; AC unknown must block.
func TestCheckFlashPower(t *testing.T) {
	cases := []struct {
		name string
		p    PowerStatus
		ok   bool
	}{
		{"desktop, no battery", PowerStatus{ACLineStatus: 1, BatteryFlag: 128, BatteryLifePercent: 255}, true},
		{"AC on at 24", PowerStatus{ACLineStatus: 1, BatteryFlag: 8, BatteryLifePercent: 24}, false},
		{"AC on at 25", PowerStatus{ACLineStatus: 1, BatteryFlag: 8, BatteryLifePercent: 25}, true},
		{"AC on at 100, high flag", PowerStatus{ACLineStatus: 1, BatteryFlag: 1, BatteryLifePercent: 100}, true},
		{"AC on at 10", PowerStatus{ACLineStatus: 1, BatteryFlag: 2, BatteryLifePercent: 10}, false},
		{"AC off, full battery", PowerStatus{ACLineStatus: 0, BatteryFlag: 1, BatteryLifePercent: 100}, false},
		{"AC off, desktop", PowerStatus{ACLineStatus: 0, BatteryFlag: 128, BatteryLifePercent: 255}, false},
		{"AC unknown", PowerStatus{ACLineStatus: 255, BatteryFlag: 1, BatteryLifePercent: 100}, false},
		{"AC unknown, desktop", PowerStatus{ACLineStatus: 255, BatteryFlag: 128, BatteryLifePercent: 255}, false},
		{"battery status unknown", PowerStatus{ACLineStatus: 1, BatteryFlag: 255, BatteryLifePercent: 255}, false},
		{"battery present, percent unknown", PowerStatus{ACLineStatus: 1, BatteryFlag: 8, BatteryLifePercent: 255}, false},
		{"no-battery flag with a stray bit", PowerStatus{ACLineStatus: 1, BatteryFlag: 128 | 8, BatteryLifePercent: 255}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ok, reason := CheckFlashPower(c.p)
			if ok != c.ok {
				t.Fatalf("ok=%v reason=%q, want ok=%v", ok, reason, c.ok)
			}
			if !ok && reason == "" {
				t.Fatal("a refusal must say why")
			}
		})
	}
}

func TestCheckRecoveryKey(t *testing.T) {
	const id = "4f1c2a9e-1b2c-4d5e-8f90-0123456789ab"
	cases := []struct {
		name     string
		live     []string
		escrowed []string
		on       bool
		want     bool
	}{
		{"off, empty lists", nil, nil, false, true},
		{"on, intersection", []string{id}, []string{id}, true, true},
		{"on, braces and case differ", []string{"{" + "4F1C2A9E-1B2C-4D5E-8F90-0123456789AB" + "}"}, []string{id}, true, true},
		{"on, no match", []string{"aaaaaaaa-1b2c-4d5e-8f90-0123456789ab"}, []string{id}, true, false},
		{"on, empty escrowed", []string{id}, nil, true, false},
		{"on, empty live read", nil, []string{id}, true, false},
		{"on, empty strings never match", []string{""}, []string{""}, true, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := CheckRecoveryKey(c.live, c.escrowed, c.on); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestRefuseUnlessElevated(t *testing.T) {
	restore := isElevated
	defer func() { isElevated = restore }()
	isElevated = func() bool { return false }
	if err := RefuseUnlessElevated(); err == nil {
		t.Fatal("not elevated must refuse")
	}
	isElevated = func() bool { return true }
	if err := RefuseUnlessElevated(); err != nil {
		t.Fatalf("elevated refused: %v", err)
	}
}
