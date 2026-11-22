package wakeconfig

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/security"
)

// tpmListing is manage-bde -protectors -get C: -Type TPM in the layout
// Microsoft documents (doc-derived, as bitlockerguard's samples are). profiles
// holds the line(s) under each "PCR Validation Profile:" label.
func tpmListing(profiles ...string) string {
	var b strings.Builder
	b.WriteString("BitLocker Drive Encryption: Configuration Tool version 10.0.22621\r\n")
	b.WriteString("Copyright (C) 2013 Microsoft Corporation. All rights reserved.\r\n\r\n")
	b.WriteString("Volume C: [Windows]\r\nAll Key Protectors\r\n\r\n")
	for i, p := range profiles {
		b.WriteString("    TPM:\r\n")
		b.WriteString("      ID: {00000000-0000-4000-8000-00000000000" + string(rune('1'+i)) + "}\r\n")
		b.WriteString("      PCR Validation Profile:\r\n")
		for _, line := range strings.Split(p, "\n") {
			b.WriteString("        " + line + "\r\n")
		}
		b.WriteString("        (Uses Secure Boot for integrity validation)\r\n\r\n")
	}
	return b.String()
}

const germanListing = "Volume C: [Windows]\r\nAlle Schlüsselschutzvorrichtungen\r\n\r\n    TPM:\r\n      ID: {00000000-0000-4000-8000-000000000001}\r\n      PCR-Validierungsprofil:\r\n        7, 11\r\n"

type blReaders struct {
	state      string
	stateErr   error
	listing    string
	listingErr error
	stateN     atomic.Int32
	protN      atomic.Int32
}

func (r *blReaders) readers() BitLockerReaders {
	return BitLockerReaders{
		State: func() (string, error) { r.stateN.Add(1); return r.state, r.stateErr },
		Protectors: func(ctx context.Context) (string, error) {
			r.protN.Add(1)
			return r.listing, r.listingErr
		},
	}
}

// The guard's whole decision table. Only two readings allow a firmware write:
// BitLocker positively off (no error), or on/suspended with every TPM
// protector's profile read as PCR numbers and none of them PCR 1. Everything
// else blocks, with a fixed reason.
func TestBitLockerGuardTable(t *testing.T) {
	for _, tc := range []struct {
		name       string
		r          *blReaders
		wantOK     bool
		wantReason string
		wantProt   bool // manage-bde consulted
	}{
		{"off", &blReaders{state: security.BitLockerStateOff}, true, "", false},
		{"off but the module is missing (device encryption may still be on)", &blReaders{state: security.BitLockerStateOff, stateErr: security.ErrBitLockerUnavailable}, false, reasonBitLockerStateUnknown, false},
		{"state error", &blReaders{state: security.BitLockerStateUnknown, stateErr: errors.New("powershell exit 1")}, false, reasonBitLockerStateUnknown, false},
		{"unknown state string", &blReaders{state: "weird"}, false, reasonBitLockerStateUnknown, false},
		{"unknown state", &blReaders{state: security.BitLockerStateUnknown}, false, reasonBitLockerStateUnknown, false},
		{"on, default UEFI profile", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("7, 11")}, true, "", true},
		{"on, legacy profile without PCR 1", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("0, 2, 4, 11")}, true, "", true},
		{"on, PCR 11 is not PCR 1", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("11, 7")}, true, "", true},
		{"suspended is treated as on", &blReaders{state: security.BitLockerStateSuspended, listing: tpmListing("7, 11")}, true, "", true},
		{"suspended with PCR 1", &blReaders{state: security.BitLockerStateSuspended, listing: tpmListing("1, 7, 11")}, false, reasonBitLockerPCR1, true},
		{"on, PCR 1 bound", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("0, 1, 2, 3, 4, 5, 11")}, false, reasonBitLockerPCR1, true},
		{"on, PCR 1 alone", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("1")}, false, reasonBitLockerPCR1, true},
		{"on, one of two protectors binds PCR 1", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("7, 11", "1, 7")}, false, reasonBitLockerPCR1, true},
		{"on, wrapped profile carries PCR 1", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("0, 2, 4\n1, 11")}, false, reasonBitLockerPCR1, true},
		{"on, wrapped profile with a trailing comma", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("0, 2, 4,\n1, 11")}, false, reasonBitLockerProfileUnreadable, true},
		{"on, manage-bde failed", &blReaders{state: security.BitLockerStateOn, listingErr: errors.New("manage-bde: exit status 1")}, false, reasonBitLockerProfileUnreadable, true},
		{"on, localized output", &blReaders{state: security.BitLockerStateOn, listing: germanListing}, false, reasonBitLockerProfileUnreadable, true},
		{"on, no TPM protector listed", &blReaders{state: security.BitLockerStateOn, listing: tpmListing()}, false, reasonBitLockerProfileUnreadable, true},
		{"on, empty output", &blReaders{state: security.BitLockerStateOn, listing: ""}, false, reasonBitLockerProfileUnreadable, true},
		{"on, profile line missing", &blReaders{state: security.BitLockerStateOn, listing: "PCR Validation Profile:"}, false, reasonBitLockerProfileUnreadable, true},
		{"on, profile not numbers", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("seven, eleven")}, false, reasonBitLockerProfileUnreadable, true},
		{"on, PCR out of range", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("7, 24")}, false, reasonBitLockerProfileUnreadable, true},
		{"on, negative PCR", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("-1, 7")}, false, reasonBitLockerProfileUnreadable, true},
		{"on, empty profile", &blReaders{state: security.BitLockerStateOn, listing: tpmListing("")}, false, reasonBitLockerProfileUnreadable, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ok, reason := checkBitLocker(context.Background(), tc.r.readers())
			if ok != tc.wantOK || reason != tc.wantReason {
				t.Fatalf("got ok=%v reason=%q, want ok=%v reason=%q", ok, reason, tc.wantOK, tc.wantReason)
			}
			if got := tc.r.protN.Load() > 0; got != tc.wantProt {
				t.Fatalf("manage-bde consulted=%v, want %v", got, tc.wantProt)
			}
		})
	}
}

func TestBitLockerPcr1BlocksWrite(t *testing.T) {
	r := &blReaders{state: security.BitLockerStateOn, listing: tpmListing("1, 7, 11")}
	if ok, reason := checkBitLocker(context.Background(), r.readers()); ok || reason != reasonBitLockerPCR1 {
		t.Fatalf("got %v %q", ok, reason)
	}
}

func TestBitLockerProfileUnreadableBlocksWrite(t *testing.T) {
	r := &blReaders{state: security.BitLockerStateOn, listingErr: errors.New("access denied")}
	if ok, reason := checkBitLocker(context.Background(), r.readers()); ok || reason != reasonBitLockerProfileUnreadable {
		t.Fatalf("got %v %q", ok, reason)
	}
}

func TestBitLockerDefaultProfileAllowsWrite(t *testing.T) {
	r := &blReaders{state: security.BitLockerStateOn, listing: tpmListing("7, 11")}
	if ok, reason := checkBitLocker(context.Background(), r.readers()); !ok || reason != "" {
		t.Fatalf("got %v %q", ok, reason)
	}
}

func TestBitLockerOffAllowsWrite(t *testing.T) {
	r := &blReaders{state: security.BitLockerStateOff}
	if ok, reason := checkBitLocker(context.Background(), r.readers()); !ok || reason != "" {
		t.Fatalf("got %v %q", ok, reason)
	}
	if r.protN.Load() != 0 {
		t.Fatal("manage-bde must not run when BitLocker is off")
	}
}

// Missing seams, a hung reader, a cancelled context and a panicking reader all
// fail closed.
func TestBitLockerGuardFailsClosed(t *testing.T) {
	if ok, reason := checkBitLocker(context.Background(), BitLockerReaders{}); ok || reason != reasonBitLockerStateUnknown {
		t.Fatalf("no seams: %v %q", ok, reason)
	}
	if ok, reason := checkBitLocker(context.Background(), BitLockerReaders{State: func() (string, error) { return security.BitLockerStateOn, nil }}); ok || reason != reasonBitLockerProfileUnreadable {
		t.Fatalf("no protector seam: %v %q", ok, reason)
	}

	release := make(chan struct{})
	defer close(release)
	hung := BitLockerReaders{State: func() (string, error) { <-release; return security.BitLockerStateOff, nil }}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	if ok, reason := checkBitLocker(ctx, hung); ok || reason != reasonBitLockerStateUnknown {
		t.Fatalf("hung state read: %v %q", ok, reason)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("the guard waited on a hung reader")
	}

	slowProt := BitLockerReaders{
		State: func() (string, error) { return security.BitLockerStateOn, nil },
		Protectors: func(ctx context.Context) (string, error) {
			<-ctx.Done()
			return tpmListing("7, 11"), nil // output after the deadline is not trusted
		},
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel2()
	if ok, reason := checkBitLocker(ctx2, slowProt); ok || reason != reasonBitLockerProfileUnreadable {
		t.Fatalf("protectors past the deadline: %v %q", ok, reason)
	}

	cancelled, cancel3 := context.WithCancel(context.Background())
	cancel3()
	r := &blReaders{state: security.BitLockerStateOff}
	if ok, _ := checkBitLocker(cancelled, r.readers()); ok {
		t.Fatal("a cancelled context must not allow a write")
	}

	panicky := BitLockerReaders{State: func() (string, error) { panic("boom") }}
	if ok, reason := checkBitLocker(context.Background(), panicky); ok || reason != reasonBitLockerStateUnknown {
		t.Fatalf("panicking state read: %v %q", ok, reason)
	}
	panickyProt := BitLockerReaders{
		State:      func() (string, error) { return security.BitLockerStateOn, nil },
		Protectors: func(context.Context) (string, error) { panic("boom") },
	}
	if ok, reason := checkBitLocker(context.Background(), panickyProt); ok || reason != reasonBitLockerProfileUnreadable {
		t.Fatalf("panicking protector read: %v %q", ok, reason)
	}
}

// The guard only ever reads. Neither its files nor anything else in this
// package may suspend, resume or disable BitLocker, or reach bitlockerguard's
// write seams. The banned words are built from parts so this file does not
// contain them.
func TestNothingSuspendsBitLocker(t *testing.T) {
	banned := []string{
		"Suspend" + "-BitLocker", "Resume" + "-BitLocker", "Disable" + "-BitLocker", "Enable" + "-BitLocker",
		"-protectors" + " -disable", "-protectors" + " -enable", "-protectors" + " -delete", `"-` + `off"`, "-" + "off C:",
		"bitlockerguard." + "Suspend", "bitlockerguard." + "Resume", "bitlockerguard." + "SystemDeps",
		"bitlockerguard." + "MarkInstalling", "Suspend" + "Volume", "Resume" + "Volume",
	}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		scanned++
		for _, w := range banned {
			if strings.Contains(string(b), w) {
				t.Errorf("%s contains %q", f, w)
			}
		}
	}
	if scanned < 10 {
		t.Fatalf("scanned only %d files", scanned)
	}
	for _, f := range []string{"bitlocker.go", "bitlocker_windows.go", "bitlocker_other.go"} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
}
