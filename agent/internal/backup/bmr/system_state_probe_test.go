package bmr

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// probeCase is one integrity mode crossed with one outcome of reading the
// system-state manifest: only a confirmed absence (ErrObjectNotFound) means
// "this snapshot has no system state"; any other failure must fail the
// system-state step whenever the command carries an integrity block. Without
// one (an older server) the earlier behaviour is kept.
type probeCase struct {
	name      string
	mode      string // "none", "attested-no-state-object", "override", "informational"
	dlErr     error
	wantFatal bool
}

func probeCases() []probeCase {
	notFound := fmt.Errorf("%w: system-state/manifest.json", providers.ErrObjectNotFound)
	generic := errors.New("storage read timed out")
	var out []probeCase
	for _, mode := range []string{"attested-no-state-object", "override", "informational"} {
		out = append(out,
			probeCase{name: mode + "/confirmed absent", mode: mode, dlErr: notFound},
			probeCase{name: mode + "/other download error", mode: mode, dlErr: generic, wantFatal: true},
		)
	}
	out = append(out,
		probeCase{name: "none/confirmed absent", mode: "none", dlErr: notFound},
		probeCase{name: "none/other download error keeps the earlier soft skip", mode: "none", dlErr: generic},
	)
	return out
}

func probeExpectation(t *testing.T, fx *stateFixture, mode string) *integrity.Expectation {
	t.Helper()
	switch mode {
	case "attested-no-state-object":
		return fx.attested(t, false, nil)
	case "override":
		return overrideExpectation(t, fx.snapshotID)
	case "informational":
		e, err := integrity.Parse([]byte(`{"v":1,"mode":"unattested","snapshotId":"` + fx.snapshotID + `","reason":"unattested_legacy"}`))
		if err != nil {
			t.Fatal(err)
		}
		return e
	}
	return nil
}

func TestApplySystemState_OnlyConfirmedAbsenceMeansNoSystemState(t *testing.T) {
	for _, tc := range probeCases() {
		t.Run(tc.name, func(t *testing.T) {
			fx := newStateFixture(t, "snap-probe", nil, false)
			fx.provider.failErr = tc.dlErr
			fr := useFakeRestorer(t, &fakeStateRestorer{})
			res := applySystemState(context.Background(), RecoveryConfig{SnapshotID: fx.snapshotID, Integrity: probeExpectation(t, fx, tc.mode)}, fx.provider)
			if fr.restoreCalls != 0 {
				t.Fatal("restorer ran without a state manifest")
			}
			if tc.wantFatal {
				if res.err == nil {
					t.Fatalf("want the system-state step to fail, got warnings %v", res.warnings)
				}
				if !strings.Contains(res.err.Error(), "storage read timed out") {
					t.Fatalf("error %q does not carry the download failure", res.err)
				}
				return
			}
			if res.err != nil {
				t.Fatalf("unexpected error: %v", res.err)
			}
			if !strings.Contains(strings.Join(res.warnings, "\n"), "no system state found") {
				t.Fatalf("warnings %v, want the no-system-state skip", res.warnings)
			}
		})
	}
}

func TestDeferWindowsSystemState_OnlyConfirmedAbsenceMeansNoSystemState(t *testing.T) {
	for _, tc := range probeCases() {
		t.Run(tc.name, func(t *testing.T) {
			fx := newStateFixture(t, "snap-probe-win", nil, false)
			fx.provider.failErr = tc.dlErr
			res := deferWindowsSystemState(RecoveryConfig{SnapshotID: fx.snapshotID, Integrity: probeExpectation(t, fx, tc.mode)}, fx.provider)
			if tc.wantFatal {
				if res.err == nil {
					t.Fatalf("want the system-state step to fail, got %+v", res)
				}
				if res.requiresRebuild {
					t.Fatal("a failed probe must not be reported as system state found")
				}
				return
			}
			if res.err != nil || res.requiresRebuild {
				t.Fatalf("result %+v, want the no-system-state skip", res)
			}
		})
	}
}

func TestDownloadSystemStateVerified_AttestedProbeErrorIsNotAbsence(t *testing.T) {
	fx := newStateFixture(t, "snap-probe-dl", nil, false)
	fx.provider.failErr = errors.New("storage read timed out")
	_, _, err := DownloadSystemStateVerified(context.Background(), fx.provider, fx.snapshotID, false, t.TempDir(), fx.attested(t, false, nil))
	if err == nil || errors.Is(err, ErrNoSystemState) {
		t.Fatalf("err = %v, want a failure that is not ErrNoSystemState", err)
	}
}
