package main

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestUserHelperBinaryHasGUISubsystem cross-compiles the SAME source as the
// user-helper binary (./cmd/breeze-agent with -H windowsgui) and asserts the
// resulting PE file has subsystem byte 2 (IMAGE_SUBSYSTEM_WINDOWS_GUI), not 3
// (IMAGE_SUBSYSTEM_WINDOWS_CUI).
//
// This is a regression guard for the "console window flashes at user logon"
// bug: without -H windowsgui the kernel allocates a console window every time
// the AgentUserHelper scheduled task fires, regardless of <Hidden>true</Hidden>
// in the task XML. The Makefile target build-windows-user-helper and the CI
// matrix step that builds breeze-user-helper-windows-amd64.exe both pass the
// flag; this test ensures neither silently drops it.
//
// Runs on any platform that has the Go cross-compile toolchain (CI's Linux
// runner is enough). Skipped if `go` is not on PATH.
func TestUserHelperBinaryHasGUISubsystem(t *testing.T) {
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go toolchain not on PATH")
	}

	tmpDir := t.TempDir()
	outPath := filepath.Join(tmpDir, "breeze-user-helper.exe")

	cmd := exec.Command(goBin,
		"build",
		"-ldflags", "-s -w -H windowsgui",
		"-o", outPath,
		".",
	)
	cmd.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("cross-compile failed: %v\n%s", err, string(out))
	}

	subsys, err := readPESubsystem(outPath)
	if err != nil {
		t.Fatalf("read PE subsystem: %v", err)
	}

	const (
		imageSubsystemWindowsGUI = 2
		imageSubsystemWindowsCUI = 3
	)

	if subsys != imageSubsystemWindowsGUI {
		t.Fatalf("user-helper binary built with -H windowsgui has subsystem %d, want %d (GUI). "+
			"Subsystem %d is %s. Did the Makefile or CI workflow drop the -H windowsgui linker flag? "+
			"Restoring it is required to prevent the kernel allocating a console window at scheduled-task logon.",
			subsys, imageSubsystemWindowsGUI,
			subsys, subsystemName(subsys))
	}

}

// TestAgentBinaryHasCUISubsystem is the counter-assertion to
// TestUserHelperBinaryHasGUISubsystem: cross-compiles the SAME source as the
// MAIN agent binary (./cmd/breeze-agent) WITHOUT the -H windowsgui flag and
// asserts the resulting PE file has subsystem byte 3 (IMAGE_SUBSYSTEM_WINDOWS_CUI).
//
// Without this counter-assertion, a Makefile refactor or CI workflow change
// that accidentally added -H windowsgui to the default agent build would
// silently make breeze-agent.exe a GUI-subsystem binary — `breeze-agent
// enroll` and other CLI subcommands would then run without a usable stdout
// (admins running the CLI from cmd would see no output), and the post-install
// MSI enrollment CA would lose its enroll-last-error.txt diagnostic trail
// because the CA captures stderr.
//
// Together with TestUserHelperBinaryHasGUISubsystem, this pins the
// subsystem-byte invariant in both directions.
func TestAgentBinaryHasCUISubsystem(t *testing.T) {
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go toolchain not on PATH")
	}

	tmpDir := t.TempDir()
	outPath := filepath.Join(tmpDir, "breeze-agent.exe")

	cmd := exec.Command(goBin,
		"build",
		"-ldflags", "-s -w", // explicitly no -H windowsgui
		"-o", outPath,
		".",
	)
	cmd.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("cross-compile failed: %v\n%s", err, string(out))
	}

	subsys, err := readPESubsystem(outPath)
	if err != nil {
		t.Fatalf("read PE subsystem: %v", err)
	}

	const (
		imageSubsystemWindowsGUI = 2
		imageSubsystemWindowsCUI = 3
	)

	if subsys != imageSubsystemWindowsCUI {
		t.Fatalf("default agent binary (no -H windowsgui) has subsystem %d, want %d (CUI/console). "+
			"Subsystem %d is %s. Did the Makefile or CI workflow accidentally add -H windowsgui to "+
			"the default agent build? That would break `breeze-agent enroll` and the post-install "+
			"diagnostic trail because the CLI loses its stdout.",
			subsys, imageSubsystemWindowsCUI,
			subsys, subsystemName(subsys))
	}
}

// readPESubsystem returns the value of the IMAGE_OPTIONAL_HEADER.Subsystem
// field from a Windows PE file. For PE32 and PE32+ the field lives at PE
// header offset 0x5c (44 bytes into the optional header after the magic).
func readPESubsystem(path string) (uint16, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	// MZ stub points at the PE header offset at file offset 0x3c.
	if _, err := f.Seek(0x3c, io.SeekStart); err != nil {
		return 0, err
	}
	var peOff uint32
	if err := binary.Read(f, binary.LittleEndian, &peOff); err != nil {
		return 0, err
	}

	// "PE\0\0" signature + COFF header (20 bytes) starts at peOff. The
	// optional header begins at peOff + 0x18. Subsystem is at +0x5c
	// inside the optional header (same offset for PE32 and PE32+ because
	// the preceding fields are identically sized in both layouts).
	if _, err := f.Seek(int64(peOff)+0x5c, io.SeekStart); err != nil {
		return 0, err
	}
	var subsys uint16
	if err := binary.Read(f, binary.LittleEndian, &subsys); err != nil {
		if errors.Is(err, io.EOF) {
			return 0, errors.New("truncated PE: subsystem field beyond EOF")
		}
		return 0, err
	}
	return subsys, nil
}

func subsystemName(s uint16) string {
	switch s {
	case 1:
		return "NATIVE"
	case 2:
		return "WINDOWS_GUI"
	case 3:
		return "WINDOWS_CUI (console)"
	default:
		return "unknown"
	}
}
