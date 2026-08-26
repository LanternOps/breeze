package pamlifetime

import "testing"

func TestReconciliationObservationID(t *testing.T) {
	t.Run("golden vector", func(t *testing.T) {
		got, err := ReconciliationObservationID(Result{
			ActuationID: "A0000000-0000-4000-8000-000000000001",
			Generation:  7,
			State:       ResultFailed,
			Evidence:    ResultEvidence{BootID: "windows-boot-42"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if want := "cf09e252-8185-580e-816b-e8708805f663"; got != want {
			t.Fatalf("observation ID = %q, want %q", got, want)
		}
	})

	base := Result{
		ActuationID: "A0000000-0000-4000-8000-000000000001",
		Generation:  7,
		State:       ResultFailed,
		Evidence:    ResultEvidence{BootID: "boot-\"quoted\"-\\-\n"},
	}
	upper, err := ReconciliationObservationID(base)
	if err != nil {
		t.Fatal(err)
	}
	base.ActuationID = "a0000000-0000-4000-8000-000000000001"
	lower, err := ReconciliationObservationID(base)
	if err != nil {
		t.Fatal(err)
	}
	if upper != lower {
		t.Fatalf("UUID case changed identity: upper=%q lower=%q", upper, lower)
	}

	variants := []Result{
		{ActuationID: base.ActuationID, Generation: 8, State: base.State, Evidence: base.Evidence},
		{ActuationID: base.ActuationID, Generation: base.Generation, State: ResultCleaned, Evidence: base.Evidence},
		{ActuationID: base.ActuationID, Generation: base.Generation, State: base.State, Evidence: ResultEvidence{BootID: "different-native-boot"}},
	}
	for _, variant := range variants {
		got, err := ReconciliationObservationID(variant)
		if err != nil {
			t.Fatal(err)
		}
		if got == lower {
			t.Fatalf("variant did not change identity: %+v", variant)
		}
	}

	unavailable := Result{
		ActuationID: base.ActuationID,
		Generation:  9,
		State:       ResultFailed,
		Evidence:    ResultEvidence{BootID: "windows-boot-unavailable"},
	}
	first, err := ReconciliationObservationID(unavailable)
	if err != nil {
		t.Fatal(err)
	}
	second, err := ReconciliationObservationID(unavailable)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatalf("unavailable boot marker was not deterministic: %q != %q", first, second)
	}
}

func TestReconciliationObservationIDRejectsIncompleteIdentity(t *testing.T) {
	valid := Result{
		ActuationID: "a0000000-0000-4000-8000-000000000001",
		Generation:  1,
		State:       ResultFailed,
		Evidence:    ResultEvidence{BootID: "boot-1"},
	}

	tests := map[string]Result{
		"invalid actuation": func() Result { r := valid; r.ActuationID = "not-a-uuid"; return r }(),
		"zero generation":   func() Result { r := valid; r.Generation = 0; return r }(),
		"empty state":       func() Result { r := valid; r.State = ""; return r }(),
		"empty boot ID":     func() Result { r := valid; r.Evidence.BootID = ""; return r }(),
	}
	for name, result := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := ReconciliationObservationID(result); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}
