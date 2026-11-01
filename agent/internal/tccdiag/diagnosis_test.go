package tccdiag

import (
	"errors"
	"reflect"
	"testing"
)

func boolp(v bool) *bool { return &v }

func TestDeriveServiceVerdict(t *testing.T) {
	cases := []struct {
		name string
		in   ServiceDiagnosis
		want Verdict
	}{
		{"no database could be read", ServiceDiagnosis{Observed: false, Error: "no Full Disk Access"}, VerdictUnobservable},
		{"database read, no row for this path", ServiceDiagnosis{Observed: true, RowFound: false}, VerdictNotGranted},
		{"row denied", ServiceDiagnosis{Observed: true, RowFound: true, AuthValue: 0}, VerdictNotGranted},
		{"row unknown", ServiceDiagnosis{Observed: true, RowFound: true, AuthValue: 1}, VerdictNotGranted},
		{"row limited", ServiceDiagnosis{Observed: true, RowFound: true, AuthValue: 3}, VerdictNotGranted},
		{"legacy self-heal row (auth_reason 4, csreq NULL)", ServiceDiagnosis{Observed: true, RowFound: true, AuthValue: 2, AuthReason: 4, CsreqNull: true}, VerdictLegacyRowNoCsreq},
		{"allowed row with NULL csreq, other reason", ServiceDiagnosis{Observed: true, RowFound: true, AuthValue: 2, AuthReason: 2, CsreqNull: true}, VerdictLegacyRowNoCsreq},
		{"denied row with NULL csreq is still not granted", ServiceDiagnosis{Observed: true, RowFound: true, AuthValue: 0, CsreqNull: true}, VerdictNotGranted},
		{"stored requirement not satisfied (ad-hoc re-sign)", ServiceDiagnosis{Observed: true, RowFound: true, AuthValue: 2, RequirementSatisfied: boolp(false)}, VerdictRequirementMismatch},
		{"stored requirement could not be evaluated", ServiceDiagnosis{Observed: true, RowFound: true, AuthValue: 2, Error: "SecRequirementCreateWithData: -67052"}, VerdictUnobservable},
		{"row granted and requirement satisfied", ServiceDiagnosis{Observed: true, RowFound: true, AuthValue: 2, RequirementSatisfied: boolp(true)}, VerdictUnexplained},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := deriveServiceVerdict(tc.in); got != tc.want {
				t.Fatalf("deriveServiceVerdict(%+v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestOverallVerdict(t *testing.T) {
	cases := []struct {
		name string
		in   []Verdict
		want Verdict
	}{
		{"nothing diagnosed", nil, VerdictUnobservable},
		{"single mismatch", []Verdict{VerdictRequirementMismatch}, VerdictRequirementMismatch},
		{"mismatch outranks unobservable", []Verdict{VerdictUnobservable, VerdictRequirementMismatch}, VerdictRequirementMismatch},
		{"legacy outranks not granted", []Verdict{VerdictNotGranted, VerdictLegacyRowNoCsreq}, VerdictLegacyRowNoCsreq},
		{"mismatch outranks legacy", []Verdict{VerdictLegacyRowNoCsreq, VerdictRequirementMismatch}, VerdictRequirementMismatch},
		{"not granted outranks unexplained", []Verdict{VerdictUnexplained, VerdictNotGranted}, VerdictNotGranted},
		// "The rows are fine" holds only when every denied service was seen.
		{"unobservable outranks unexplained", []Verdict{VerdictUnexplained, VerdictUnobservable}, VerdictUnobservable},
		{"all unexplained", []Verdict{VerdictUnexplained, VerdictUnexplained}, VerdictUnexplained},
		{"all unobservable", []Verdict{VerdictUnobservable, VerdictUnobservable}, VerdictUnobservable},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			services := make([]ServiceDiagnosis, len(tc.in))
			for i, v := range tc.in {
				services[i] = ServiceDiagnosis{Verdict: v}
			}
			if got := overallVerdict(services); got != tc.want {
				t.Fatalf("overallVerdict(%v) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestDeniedServices(t *testing.T) {
	cases := []struct {
		screen, ax bool
		want       []Service
	}{
		{false, false, nil},
		{true, false, []Service{ServiceScreenCapture}},
		{false, true, []Service{ServiceAccessibility}},
		{true, true, []Service{ServiceScreenCapture, ServiceAccessibility}},
	}
	for _, tc := range cases {
		if got := DeniedServices(tc.screen, tc.ax); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("DeniedServices(%t, %t) = %v, want %v", tc.screen, tc.ax, got, tc.want)
		}
	}
}

// fakeCode stands in for Security.framework.
type fakeCode struct {
	signing Signing
	// reqs maps a csreq blob to its decoded string and whether the running
	// code satisfies it; a missing blob is an evaluation error.
	reqs  map[string]fakeReq
	calls int
}

type fakeReq struct {
	text      string
	satisfied bool
}

func (f *fakeCode) Signing() Signing { return f.signing }

func (f *fakeCode) CheckRequirement(csreq []byte) (string, bool, error) {
	f.calls++
	r, ok := f.reqs[string(csreq)]
	if !ok {
		return "", false, errors.New("SecRequirementCreateWithData: -67052")
	}
	return r.text, r.satisfied, nil
}

// fakeRows stands in for the read-only TCC.db reader.
type fakeRows struct {
	dbs   map[string][]Row
	errs  map[string]error
	reads []string
}

func (f *fakeRows) ReadRows(path string, clients []string, services []Service) ([]Row, error) {
	f.reads = append(f.reads, path)
	if err := f.errs[path]; err != nil {
		return nil, err
	}
	return f.dbs[path], nil
}

const (
	helperPath = "/usr/local/bin/breeze-desktop-helper"
	devIDReq   = `identifier "breeze-desktop-helper-darwin-amd64" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = D8W6N2JYMA`
	adhocDR    = `cdhash H"0123456789abcdef0123456789abcdef01234567"`
	devIDCsreq = "csreq-devid"
	systemDB   = "/Library/Application Support/com.apple.TCC/TCC.db"
	userDB     = "/Users/u/Library/Application Support/com.apple.TCC/TCC.db"
)

func baseEnv(code *fakeCode, rows *fakeRows) Env {
	return Env{
		Code:           code,
		Rows:           rows,
		ExecutablePath: helperPath,
		Clients:        []string{helperPath},
		SystemDB:       systemDB,
		UserDB:         userDB,
		MacOSVersion:   "15.8.1",
		MacOSBuild:     "24H32",
	}
}

// The #5953 Host B reproduction: an ad-hoc re-signed helper against rows
// granted to the Developer ID build.
func TestDiagnose_AdhocHelperAgainstDeveloperIDRows(t *testing.T) {
	code := &fakeCode{
		signing: Signing{Kind: SigningAdhoc, Identifier: "breeze-desktop-helper-darwin-amd64", DesignatedRequirement: adhocDR},
		reqs:    map[string]fakeReq{devIDCsreq: {text: devIDReq, satisfied: false}},
	}
	rows := &fakeRows{dbs: map[string][]Row{systemDB: {
		{Service: ServiceScreenCapture, Client: helperPath, AuthValue: 2, AuthReason: 2, Csreq: []byte(devIDCsreq), LastModified: 1761955200},
		{Service: ServiceAccessibility, Client: helperPath, AuthValue: 2, AuthReason: 2, Csreq: []byte(devIDCsreq)},
	}}}

	d := Diagnose(baseEnv(code, rows), []Service{ServiceScreenCapture, ServiceAccessibility})

	if d.Verdict != VerdictRequirementMismatch {
		t.Fatalf("verdict = %q, want requirement_mismatch", d.Verdict)
	}
	if len(d.Services) != 2 {
		t.Fatalf("services = %+v, want 2", d.Services)
	}
	sc := d.Services[0]
	if sc.Service != ServiceScreenCapture || sc.Database != "system" || !sc.RowFound || sc.AuthValue != 2 ||
		sc.CsreqNull || sc.StoredRequirement != devIDReq || sc.RequirementSatisfied == nil || *sc.RequirementSatisfied ||
		sc.LastModified != 1761955200 || sc.Verdict != VerdictRequirementMismatch {
		t.Fatalf("screen capture diagnosis = %+v", sc)
	}
	if d.Signing.DesignatedRequirement != adhocDR || d.MacOSBuild != "24H32" || d.ExecutablePath != helperPath {
		t.Fatalf("diagnosis header = %+v", d)
	}
	if !reflect.DeepEqual(rows.reads, []string{systemDB}) {
		t.Fatalf("read databases %v, want only the system database when it is readable", rows.reads)
	}
}

// The second #5953 path: a row left by the retired self-heal (<= 0.105.2).
func TestDiagnose_LegacySelfHealRow(t *testing.T) {
	code := &fakeCode{signing: Signing{Kind: SigningDeveloperID, TeamID: "D8W6N2JYMA", DesignatedRequirement: devIDReq}}
	rows := &fakeRows{dbs: map[string][]Row{systemDB: {
		{Service: ServiceScreenCapture, Client: helperPath, AuthValue: 2, AuthReason: 4, Csreq: nil},
	}}}

	d := Diagnose(baseEnv(code, rows), []Service{ServiceScreenCapture})

	if d.Verdict != VerdictLegacyRowNoCsreq {
		t.Fatalf("verdict = %q, want legacy_row_no_csreq", d.Verdict)
	}
	if s := d.Services[0]; !s.CsreqNull || s.AuthReason != 4 || s.RequirementSatisfied != nil {
		t.Fatalf("service = %+v, want csreqNull, authReason 4, no requirement check", s)
	}
	if code.calls != 0 {
		t.Fatalf("CheckRequirement called %d times for a NULL csreq", code.calls)
	}
}

func TestDiagnose_NoRowIsNotGranted(t *testing.T) {
	code := &fakeCode{signing: Signing{Kind: SigningDeveloperID}}
	rows := &fakeRows{dbs: map[string][]Row{systemDB: {
		// Another client's row must not count.
		{Service: ServiceScreenCapture, Client: "/usr/local/bin/other", AuthValue: 2},
	}}}

	d := Diagnose(baseEnv(code, rows), []Service{ServiceScreenCapture})

	if d.Verdict != VerdictNotGranted || d.Services[0].RowFound {
		t.Fatalf("diagnosis = %+v, want not_granted without a row", d)
	}
}

func TestDiagnose_GrantedAndSatisfiedIsUnexplained(t *testing.T) {
	code := &fakeCode{
		signing: Signing{Kind: SigningDeveloperID, TeamID: "D8W6N2JYMA", DesignatedRequirement: devIDReq},
		reqs:    map[string]fakeReq{devIDCsreq: {text: devIDReq, satisfied: true}},
	}
	rows := &fakeRows{dbs: map[string][]Row{systemDB: {
		{Service: ServiceScreenCapture, Client: helperPath, AuthValue: 2, Csreq: []byte(devIDCsreq)},
	}}}

	if d := Diagnose(baseEnv(code, rows), []Service{ServiceScreenCapture}); d.Verdict != VerdictUnexplained {
		t.Fatalf("verdict = %q, want unexplained", d.Verdict)
	}
}

// Without Full Disk Access the system database cannot be opened; a row in the
// user database still answers, and a service missing from it stays
// unobservable rather than "not granted" (the system database is authoritative
// for these services and was not read).
func TestDiagnose_SystemUnreadableFallsBackToUserDatabase(t *testing.T) {
	code := &fakeCode{
		signing: Signing{Kind: SigningAdhoc},
		reqs:    map[string]fakeReq{devIDCsreq: {text: devIDReq, satisfied: false}},
	}
	rows := &fakeRows{
		errs: map[string]error{systemDB: ErrNotReadable},
		dbs: map[string][]Row{userDB: {
			{Service: ServiceScreenCapture, Client: helperPath, AuthValue: 2, Csreq: []byte(devIDCsreq)},
		}},
	}

	d := Diagnose(baseEnv(code, rows), []Service{ServiceScreenCapture, ServiceAccessibility})

	if !reflect.DeepEqual(rows.reads, []string{systemDB, userDB}) {
		t.Fatalf("read databases %v, want system then user", rows.reads)
	}
	sc, ax := d.Services[0], d.Services[1]
	if sc.Database != "user" || sc.Verdict != VerdictRequirementMismatch {
		t.Fatalf("screen capture = %+v, want requirement_mismatch from the user database", sc)
	}
	if ax.Observed || ax.Verdict != VerdictUnobservable || ax.Error == "" {
		t.Fatalf("accessibility = %+v, want unobservable with an explanation", ax)
	}
	if d.Verdict != VerdictRequirementMismatch {
		t.Fatalf("verdict = %q, want requirement_mismatch", d.Verdict)
	}
}

func TestDiagnose_NeitherDatabaseReadable(t *testing.T) {
	code := &fakeCode{signing: Signing{Kind: SigningAdhoc, DesignatedRequirement: adhocDR}}
	rows := &fakeRows{errs: map[string]error{systemDB: ErrNotReadable, userDB: ErrNotReadable}}

	d := Diagnose(baseEnv(code, rows), []Service{ServiceScreenCapture})

	if d.Verdict != VerdictUnobservable {
		t.Fatalf("verdict = %q, want unobservable", d.Verdict)
	}
	// The signing identity is still reported: on its own it names an ad-hoc
	// helper (#5953 Host B) even when no row can be read.
	if d.Signing.Kind != SigningAdhoc {
		t.Fatalf("signing = %+v, want the ad-hoc identity reported", d.Signing)
	}
}

// A path-keyed row wins over one for a later client candidate (the
// symlink-resolved path).
func TestDiagnose_PrefersEarlierClientCandidate(t *testing.T) {
	code := &fakeCode{
		signing: Signing{Kind: SigningDeveloperID},
		reqs:    map[string]fakeReq{devIDCsreq: {text: devIDReq, satisfied: true}},
	}
	env := baseEnv(code, &fakeRows{dbs: map[string][]Row{systemDB: {
		{Service: ServiceScreenCapture, Client: "/private/resolved/helper", AuthValue: 0},
		{Service: ServiceScreenCapture, Client: helperPath, AuthValue: 2, Csreq: []byte(devIDCsreq)},
	}}})
	env.Clients = []string{helperPath, "/private/resolved/helper"}

	d := Diagnose(env, []Service{ServiceScreenCapture})

	if s := d.Services[0]; s.Client != helperPath || s.AuthValue != 2 {
		t.Fatalf("service = %+v, want the row for %s", s, helperPath)
	}
}

func TestDiagnosis_LogAttrsCarryVerdictAndBothRequirements(t *testing.T) {
	d := Diagnosis{
		Verdict:      VerdictRequirementMismatch,
		MacOSVersion: "15.8.1",
		MacOSBuild:   "24H32",
		Signing:      Signing{Kind: SigningAdhoc, DesignatedRequirement: adhocDR},
		Services: []ServiceDiagnosis{{
			Service: ServiceScreenCapture, Observed: true, Database: "system", RowFound: true, AuthValue: 2,
			StoredRequirement: devIDReq, RequirementSatisfied: boolp(false), Verdict: VerdictRequirementMismatch,
		}},
	}
	flat := flattenAttrs(d.LogAttrs())
	want := map[string]string{
		"tccVerdict":                                      "requirement_mismatch",
		"tccDiagnosis.macOSBuild":                         "24H32",
		"tccDiagnosis.signing.kind":                       "adhoc",
		"tccDiagnosis.signing.designatedRequirement":      adhocDR,
		"tccDiagnosis.screenCapture.storedRequirement":    devIDReq,
		"tccDiagnosis.screenCapture.requirementSatisfied": "false",
		"tccDiagnosis.screenCapture.authValue":            "2",
		"tccDiagnosis.screenCapture.verdict":              "requirement_mismatch",
	}
	for k, v := range want {
		if flat[k] != v {
			t.Errorf("%s = %q, want %q (all: %v)", k, flat[k], v, flat)
		}
	}
}

// No executable path means nothing to look up: an empty query must not read
// as "no row, so not granted".
func TestDiagnose_NoClientPathIsUnobservable(t *testing.T) {
	code := &fakeCode{signing: Signing{Kind: SigningDeveloperID}}
	rows := &fakeRows{dbs: map[string][]Row{systemDB: nil}}
	env := baseEnv(code, rows)
	env.Clients = nil

	d := Diagnose(env, []Service{ServiceScreenCapture})

	if d.Verdict != VerdictUnobservable || d.Services[0].Error == "" {
		t.Fatalf("diagnosis = %+v, want unobservable with a reason", d)
	}
	if len(rows.reads) != 0 {
		t.Fatalf("read %v with no client to look up", rows.reads)
	}
}
