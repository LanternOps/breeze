// win_identity.go — the Windows identity phase (W06c Part C Task 15).
//
// Every file read or write on the restored tree goes through r.rootVolume,
// the root partition's VOLUME path, never the r.rootDir folder mount (ruling
// B1/C1): on the fake the folder mount does not alias the volume, and a
// phase that worked through it would edit an empty directory and report
// success.
package rebuild

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// winBreezeDir is the restored agent's config dir (config.configDir() on
// Windows: %ProgramData%\Breeze) under the restored root volume; its data
// dir (config.GetDataDir()) is winBreezeDir\data.
func winBreezeDir(r *run) string {
	return filepath.Join(r.rootVolume, "ProgramData", "Breeze")
}

// winIdentity is identity's Windows twin (Global Constraint "Identity"):
// original → the recovery marker in ProgramData\Breeze\data; new → the
// -RESTORED computer name in every chosen control set, a new MachineGuid,
// secrets.yaml deleted and enrollment keys stripped from agent.yaml. The
// machine SID is not changed (Part 0 §4).
//
// The hives are (re)loaded through ensureWinHives — a resumed run skipped
// the restore phase that loads them, and winBoot closes them before DISM and
// bcdboot — and left loaded: validateOSState closes them (ruling C5).
func winIdentity(_ context.Context, r *run) error {
	if r.rootVolume == "" {
		return errors.New("identity: no root volume recorded for this run")
	}
	breeze := winBreezeDir(r)
	switch r.opts.Identity {
	case IdentityOriginal:
		if r.opts.Marker == nil {
			r.warn("no recovery marker given; the server will not auto-complete this recovery")
			return nil
		}
		return writeRecoveryMarker(r, filepath.Join(breeze, "data"))
	case IdentityNew:
		if err := r.ensureWinHives(); err != nil {
			return fmt.Errorf("identity: %w", err)
		}
		if len(r.controlSets) == 0 {
			return errors.New("identity: no control set to rename")
		}
		system := r.hives["SYSTEM"].Root()
		current, err := currentComputerName(system, r.controlSets[0])
		if err != nil {
			return fmt.Errorf("identity: read computer name: %w", err)
		}
		if strings.TrimSpace(current) == "" && r.layout != nil {
			// F13: never "-RESTORED"; the collector records the source's
			// COMPUTERNAME as the manifest hostname.
			current = r.layout.Hostname
		}
		name := winhive.NewComputerName(current)
		for _, cs := range r.controlSets {
			if err := winhive.SetComputerName(system, cs, name); err != nil {
				return fmt.Errorf("identity: set computer name in %s: %w", cs, err)
			}
		}
		if _, err := winhive.NewMachineGuid(r.hives["SOFTWARE"].Root()); err != nil {
			return fmt.Errorf("identity: rotate MachineGuid: %w", err)
		}
		if err := os.Remove(filepath.Join(breeze, "secrets.yaml")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("identity: delete secrets.yaml: %w", err)
		}
		return stripEnrollment(filepath.Join(breeze, "agent.yaml"))
	default:
		return fmt.Errorf("unknown identity mode %q", r.opts.Identity)
	}
}

// currentComputerName reads <controlSet>\Control\ComputerName\ComputerName;
// an absent key or value yields "" (winIdentity then falls back to the
// manifest hostname). Any other read error is returned.
func currentComputerName(system winhive.Key, controlSet string) (string, error) {
	k, err := system.OpenKey(controlSet + `\Control\ComputerName\ComputerName`)
	if errors.Is(err, winhive.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer func() { _ = k.Close() }()
	name, err := k.GetString("ComputerName")
	if errors.Is(err, winhive.ErrNotExist) {
		return "", nil
	}
	return name, err
}
