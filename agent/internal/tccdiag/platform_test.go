package tccdiag

import "testing"

func TestClassifySigning(t *testing.T) {
	cases := []struct {
		name string
		in   signingFacts
		want SigningKind
	}{
		{"release helper", signingFacts{infoOK: true, hasIdentifier: true, hasFlags: true, devIDStatus: 0}, SigningDeveloperID},
		{"codesign -s - copy", signingFacts{infoOK: true, hasIdentifier: true, hasFlags: true, adhoc: true, devIDStatus: errSecCSReqFailed}, SigningAdhoc},
		{"apple development cert", signingFacts{infoOK: true, hasIdentifier: true, hasFlags: true, devIDStatus: errSecCSReqFailed}, SigningOther},
		{"unsigned intel build", signingFacts{infoOK: true, drUnsigned: true, devIDStatus: errSecCSUnsigned}, SigningUnsigned},
		{"no identifier in signing info", signingFacts{infoOK: true, devIDStatus: errSecCSUnsigned}, SigningUnsigned},
		{"signing info unreadable", signingFacts{infoOK: false}, SigningUnknown},
		{"developer id check errored", signingFacts{infoOK: true, hasIdentifier: true, devIDStatus: -67030}, SigningUnknown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifySigning(tc.in); got != tc.want {
				t.Fatalf("classifySigning(%+v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestInterpretRequirementStatus(t *testing.T) {
	cases := []struct {
		name          string
		status        int32
		stage         int
		wantSatisfied bool
		wantErr       bool
	}{
		{"satisfied", 0, 2, true, false},
		{"requirement failed", errSecCSReqFailed, 2, false, false},
		{"running code unsigned", errSecCSUnsigned, 2, false, false},
		{"other check failure", -67061, 2, false, true},
		{"blob did not decode", -67052, 1, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := interpretRequirementStatus(tc.status, tc.stage)
			if got != tc.wantSatisfied || (err != nil) != tc.wantErr {
				t.Fatalf("interpretRequirementStatus(%d, %d) = %t, %v; want %t, err=%t",
					tc.status, tc.stage, got, err, tc.wantSatisfied, tc.wantErr)
			}
		})
	}
}

func TestBuildRowQueryBindsEveryValue(t *testing.T) {
	got := buildRowQuery(2, 2)
	want := "SELECT service, client, auth_value, auth_reason, csreq, last_modified FROM access" +
		" WHERE client IN (?,?) AND service IN (?,?)"
	if got != want {
		t.Fatalf("buildRowQuery(2, 2) = %q, want %q", got, want)
	}
}
