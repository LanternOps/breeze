package agentapp

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation"
	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

func TestContainmentCommandRegistered(t *testing.T) {
	cmd, _, err := rootCmd.Find([]string{"containment"})
	if err != nil || cmd.Name() != "containment" {
		t.Fatal("containment command is not registered")
	}
}

func TestContainmentStatusEmpty(t *testing.T) {
	dir := t.TempDir()
	cmd := newContainmentCommand(func() string { return dir })
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"status"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["phase"] != "none" || got["journalSeq"] != float64(0) || len(got) != 2 {
		t.Fatal("unexpected absent report shape")
	}
}

func TestContainmentStatusDoesNotExposeSecret(t *testing.T) {
	dir := t.TempDir()
	secret := bytes.Repeat([]byte{0x7b}, 32)
	j := journal.New()
	j.Phase = journal.PhaseCommitted
	j.Episode = &journal.EpisodeRecord{IsolationID: "11111111-1111-4111-8111-111111111111", Generation: 1, State: isolation.StateVerified, BreakGlassSecret: secret}
	if err := journal.Save(journal.Path(dir), j); err != nil {
		t.Fatal("could not write test journal")
	}
	cmd := newContainmentCommand(func() string { return dir })
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"status"})
	if err := cmd.Execute(); err != nil {
		t.Fatal("status command failed")
	}
	if strings.Contains(out.String(), "breakGlassSecret") || bytes.Contains(out.Bytes(), secret) || strings.Contains(out.String(), base64.StdEncoding.EncodeToString(secret)) {
		t.Fatal("status exposed secret material")
	}
	var report isolation.Report
	if err := json.Unmarshal(out.Bytes(), &report); err != nil || report.IsolationID != j.Episode.IsolationID {
		t.Fatal("status did not report journal episode")
	}
}

type containmentCommandFake struct {
	startup, tick, release int
	code                   string
	force                  bool
	err                    error
}

func (f *containmentCommandFake) Report() *isolation.Report {
	return &isolation.Report{Phase: journal.PhaseNone}
}
func (f *containmentCommandFake) Startup(context.Context) { f.startup++ }
func (f *containmentCommandFake) Tick(context.Context)    { f.tick++ }
func (f *containmentCommandFake) LocalRelease(_ context.Context, code string, force bool) error {
	f.release++
	f.code, f.force = code, force
	return f.err
}

func TestContainmentReleaseArguments(t *testing.T) {
	for _, tc := range []struct {
		name  string
		args  []string
		valid bool
		force bool
	}{
		{"missing", []string{"release"}, false, false},
		{"both", []string{"release", "--code", "ABCDEFGH", "--force"}, false, false},
		{"both with false force", []string{"release", "--code", "ABCDEFGH", "--force=false"}, false, false},
		{"empty code", []string{"release", "--code", ""}, false, false},
		{"blank code", []string{"release", "--code", "  "}, false, false},
		{"false force", []string{"release", "--force=false"}, false, false},
		{"extra argument", []string{"release", "--force", "extra"}, false, false},
		{"code", []string{"release", "--code", "ABCDEFGH"}, true, false},
		{"force", []string{"release", "--force"}, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &containmentCommandFake{}
			cmd := newContainmentCommandWithFactory(func() containmentCommandManager { return fake })
			cmd.SetOut(&bytes.Buffer{})
			cmd.SetErr(&bytes.Buffer{})
			cmd.SetArgs(tc.args)
			err := cmd.Execute()
			if (err == nil) != tc.valid {
				t.Fatalf("valid = %v; command error present = %v", tc.valid, err != nil)
			}
			if !tc.valid && fake.release != 0 {
				t.Fatal("invalid arguments reached LocalRelease")
			}
			if tc.valid && (fake.release != 1 || fake.force != tc.force || (!tc.force && fake.code != "ABCDEFGH")) {
				t.Fatal("wrong LocalRelease arguments")
			}
		})
	}
}

func TestContainmentReleasePropagatesError(t *testing.T) {
	want := errors.New("release failed")
	fake := &containmentCommandFake{err: want}
	cmd := newContainmentCommandWithFactory(func() containmentCommandManager { return fake })
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	cmd.SetArgs([]string{"release", "--force"})
	if !errors.Is(cmd.Execute(), want) {
		t.Fatal("LocalRelease error not returned")
	}
}

func (f *containmentCommandFake) BootApply(context.Context) error           { f.startup++; return f.err }
func (f *containmentCommandFake) RecoveryExpireCheck(context.Context) error { f.tick++; return f.err }

func TestContainmentMaintenanceCommands(t *testing.T) {
	for _, name := range []string{"boot-apply", "expire-check"} {
		for _, failure := range []error{nil, errors.New("cleanup unconfirmed")} {
			fake := &containmentCommandFake{err: failure}
			cmd := newContainmentCommandWithFactory(func() containmentCommandManager { return fake })
			cmd.SetArgs([]string{name})
			cmd.SetErr(&bytes.Buffer{})
			err := cmd.Execute()
			if !errors.Is(err, failure) || fake.startup+fake.tick != 1 {
				t.Fatalf("%s: err=%v startup=%d tick=%d", name, err, fake.startup, fake.tick)
			}
			if (name == "boot-apply" && fake.startup != 1) || (name == "expire-check" && fake.tick != 1) {
				t.Fatal("wrong recovery operation")
			}
		}
	}
}

func TestContainmentJournalSchemaWithoutManager(t *testing.T) {
	cmd := newContainmentCommandWithFactory(func() containmentCommandManager { t.Fatal("schema query constructed manager"); return nil })
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"journal-schema"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if out.String() != fmt.Sprintf("%d\n", journal.SchemaVersion) {
		t.Fatalf("schema=%q", out.String())
	}
}

func (f *containmentCommandFake) ReleaseAll(_ context.Context, kind string) error {
	f.release++
	f.code = kind
	return f.err
}

func TestContainmentReleaseAll(t *testing.T) {
	for _, tc := range []struct {
		name       string
		args       []string
		managerErr error
		calls      int
		wantErr    bool
	}{
		{"uninstall", []string{"release-all", "--reason", "uninstall"}, nil, 1, false},
		{"cleanup failure", []string{"release-all", "--reason", "uninstall"}, errors.New("absence unconfirmed"), 1, true},
		{"missing reason", []string{"release-all"}, nil, 0, true},
		{"unknown reason", []string{"release-all", "--reason", "garbage"}, nil, 0, true},
		{"extra argument", []string{"release-all", "--reason", "uninstall", "extra"}, nil, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake := &containmentCommandFake{err: tc.managerErr}
			constructed := 0
			cmd := newContainmentCommandWithFactory(func() containmentCommandManager { constructed++; return fake })
			cmd.SetArgs(tc.args)
			cmd.SetOut(&bytes.Buffer{})
			cmd.SetErr(&bytes.Buffer{})
			err := cmd.Execute()
			if (err != nil) != tc.wantErr || fake.release != tc.calls || constructed != tc.calls {
				t.Fatalf("err=%v calls=%d constructions=%d", err, fake.release, constructed)
			}
			if tc.calls > 0 && fake.code != "uninstall" {
				t.Fatalf("reason=%q", fake.code)
			}
		})
	}
}
