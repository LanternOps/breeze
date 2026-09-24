// win_validate_os.go — winValidate's OS-state step (W06c Part C Task 17).
package rebuild

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

// validateOSState is winValidate's OS-state step (Part 0 §2, Global
// Constraint "ESP and boot"):
//
//  1. close (RegFlushKey + RegUnLoadKeyW) every loaded hive FIRST, so an
//     unload failure is a validation error, not a teardown warning;
//  2. unless SkipBoot, prove the ESP carries what bcdboot writes
//     (EFI\Microsoft\Boot\{BCD,bootmgfw.efi}) plus the EFI\Boot\bootx64.efi
//     fallback loader;
//  3. load the ESP's BCD store as a hive — READ-ONLY: a store bcdboot
//     builds from BCD-Template grants Administrators only ReadKey, so a
//     KEY_ALL_ACCESS open is denied (lab-proven) — and assert the boot
//     manager's default entry: no bcdedit, no localised text parsing,
//     nothing executed (ruling C4). The BCD handle is closed (flushed +
//     unloaded) on every path.
//
// Every ESP access goes through r.espVolume, the ESP's VOLUME path (ruling
// C1); the ESP is never folder-mounted. winMountTree sets r.espVolume on
// fresh and resumed runs alike. The ESP's temporary drive letter (winBoot)
// is left to winTeardown.
func validateOSState(_ context.Context, r *run) error {
	if err := r.closeWinHives(); err != nil {
		return err
	}
	if r.opts.SkipBoot {
		return nil
	}
	if r.espVolume == "" {
		return errors.New("validate: no EFI system partition volume recorded for this run")
	}
	for _, rel := range []string{
		filepath.Join("EFI", "Microsoft", "Boot", "BCD"),
		filepath.Join("EFI", "Microsoft", "Boot", "bootmgfw.efi"),
		filepath.Join("EFI", "Boot", "bootx64.efi"),
	} {
		if _, err := os.Stat(filepath.Join(r.espVolume, rel)); err != nil {
			return fmt.Errorf("ESP is missing %s after boot phase", rel)
		}
	}
	h, err := r.opts.WinSystem.LoadHiveReadOnly(filepath.Join(r.espVolume, "EFI", "Microsoft", "Boot", "BCD"), hiveMountName(r, "BCD"))
	if err != nil {
		return fmt.Errorf("load BCD store: %w", err)
	}
	ok, err := winhive.DefaultBCDEntryExists(h.Root())
	if closeErr := h.Close(); closeErr != nil {
		if err == nil {
			return fmt.Errorf("unload BCD store: %w", closeErr)
		}
		err = errors.Join(err, fmt.Errorf("unload BCD store: %w", closeErr))
	}
	if err != nil {
		return fmt.Errorf("read BCD store: %w", err)
	}
	if !ok {
		return errors.New("BCD store has no default boot entry")
	}
	return nil
}
