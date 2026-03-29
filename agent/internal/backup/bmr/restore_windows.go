//go:build windows

package bmr

import (
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
)

// windowsRestorer applies Windows-specific system state during BMR.
type windowsRestorer struct{}

func newRestorer() Restorer {
	return &windowsRestorer{}
}

// RestoreSystemState applies Windows system state from the staging directory.
// This includes registry hives, boot configuration, certificates, services,
// and firewall rules.
func (r *windowsRestorer) RestoreSystemState(stagingDir string) error {
	slog.Info("bmr: restoring Windows system state", "stagingDir", stagingDir)

	if err := r.importRegistryHives(stagingDir); err != nil {
		return fmt.Errorf("registry restore: %w", err)
	}
	if err := r.restoreBootConfig(stagingDir); err != nil {
		slog.Warn("bmr: boot config restore failed (may not be critical on UEFI)", "error", err.Error())
	}
	if err := r.restoreCertificates(stagingDir); err != nil {
		slog.Warn("bmr: certificate restore failed", "error", err.Error())
	}
	if err := r.restoreFirewall(stagingDir); err != nil {
		slog.Warn("bmr: firewall restore failed", "error", err.Error())
	}

	slog.Info("bmr: Windows system state restore complete")
	return nil
}

// InjectDrivers installs drivers from the given directory using pnputil.
func (r *windowsRestorer) InjectDrivers(driverDir string) (int, error) {
	slog.Info("bmr: injecting Windows drivers", "driverDir", driverDir)

	pattern := filepath.Join(driverDir, "*.inf")
	cmd := exec.Command("pnputil", "/add-driver", pattern, "/install", "/subdirs")
	output, err := cmd.CombinedOutput()
	if err != nil {
		slog.Warn("bmr: pnputil driver injection had errors",
			"error", err.Error(),
			"output", string(output),
		)
	}

	// Count .inf files as an approximation of drivers processed.
	matches, _ := filepath.Glob(filepath.Join(driverDir, "**", "*.inf"))
	count := len(matches)
	if count == 0 {
		topLevel, _ := filepath.Glob(pattern)
		count = len(topLevel)
	}

	slog.Info("bmr: driver injection complete", "driversProcessed", count)
	return count, err
}

// importRegistryHives restores SYSTEM and SOFTWARE hives from backup.
func (r *windowsRestorer) importRegistryHives(stagingDir string) error {
	hives := map[string]string{
		"HKLM\\SYSTEM":   "registry_SYSTEM",
		"HKLM\\SOFTWARE": "registry_SOFTWARE",
		"HKLM\\SAM":      "registry_SAM",
		"HKLM\\SECURITY":  "registry_SECURITY",
	}
	for regKey, fileName := range hives {
		hivePath := filepath.Join(stagingDir, fileName)
		cmd := exec.Command("reg", "restore", regKey, hivePath)
		output, err := cmd.CombinedOutput()
		if err != nil {
			slog.Warn("bmr: registry restore failed",
				"hive", regKey,
				"error", err.Error(),
				"output", string(output),
			)
			// Continue with other hives -- partial restore is better than none.
			continue
		}
		slog.Info("bmr: registry hive restored", "hive", regKey)
	}
	return nil
}

// restoreBootConfig imports the BCD store.
func (r *windowsRestorer) restoreBootConfig(stagingDir string) error {
	bcdPath := filepath.Join(stagingDir, "boot_bcd")
	cmd := exec.Command("bcdedit", "/import", bcdPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("bcdedit import: %s: %w", string(output), err)
	}
	slog.Info("bmr: boot configuration restored")
	return nil
}

// restoreCertificates restores the certificate store.
func (r *windowsRestorer) restoreCertificates(stagingDir string) error {
	certDBPath := filepath.Join(stagingDir, "certificates")
	cmd := exec.Command("certutil", "-restoreDB", certDBPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("certutil restore: %s: %w", string(output), err)
	}
	slog.Info("bmr: certificates restored")
	return nil
}

// restoreFirewall imports firewall policy.
func (r *windowsRestorer) restoreFirewall(stagingDir string) error {
	fwPath := filepath.Join(stagingDir, "firewall.wfw")
	cmd := exec.Command("netsh", "advfirewall", "import", fwPath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("firewall import: %s: %w", string(output), err)
	}
	slog.Info("bmr: firewall rules restored")
	return nil
}
