//go:build linux

package bmr

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// linuxRestorer applies Linux-specific system state during BMR.
type linuxRestorer struct{}

func newRestorer() Restorer {
	return &linuxRestorer{}
}

// RestoreSystemState applies Linux system state from the staging directory.
// This includes /etc/ tree, package lists, systemd services, firewall rules,
// and crontabs.
func (r *linuxRestorer) RestoreSystemState(stagingDir string) error {
	slog.Info("bmr: restoring Linux system state", "stagingDir", stagingDir)

	if err := r.restoreEtcTree(stagingDir); err != nil {
		slog.Warn("bmr: /etc restore had errors", "error", err.Error())
	}
	if err := r.reinstallPackages(stagingDir); err != nil {
		slog.Warn("bmr: package reinstall had errors", "error", err.Error())
	}
	if err := r.restoreServices(stagingDir); err != nil {
		slog.Warn("bmr: service restore had errors", "error", err.Error())
	}
	if err := r.restoreFirewall(stagingDir); err != nil {
		slog.Warn("bmr: firewall restore failed", "error", err.Error())
	}
	if err := r.restoreCrontabs(stagingDir); err != nil {
		slog.Warn("bmr: crontab restore failed", "error", err.Error())
	}

	slog.Info("bmr: Linux system state restore complete")
	return nil
}

// InjectDrivers is a no-op on Linux (kernel modules are handled by packages).
func (r *linuxRestorer) InjectDrivers(_ string) (int, error) {
	slog.Info("bmr: driver injection not applicable on Linux (use packages)")
	return 0, nil
}

// restoreEtcTree copies the backed-up /etc/ tree back.
func (r *linuxRestorer) restoreEtcTree(stagingDir string) error {
	srcDir := filepath.Join(stagingDir, "etc")
	if _, err := os.Stat(srcDir); os.IsNotExist(err) {
		return nil
	}

	cmd := exec.Command("cp", "-a", srcDir+"/.", "/etc/")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("cp /etc: %s: %w", string(output), err)
	}
	slog.Info("bmr: /etc tree restored")
	return nil
}

// reinstallPackages reads the package list and reinstalls via dpkg or dnf.
func (r *linuxRestorer) reinstallPackages(stagingDir string) error {
	// Try dpkg-based restore first (Debian/Ubuntu).
	dpkgList := filepath.Join(stagingDir, "packages_dpkg.txt")
	if _, err := os.Stat(dpkgList); err == nil {
		return r.reinstallDpkg(dpkgList)
	}

	// Fall back to dnf/rpm list (RHEL/Fedora).
	rpmList := filepath.Join(stagingDir, "packages_rpm.txt")
	if _, err := os.Stat(rpmList); err == nil {
		return r.reinstallDnf(rpmList)
	}

	slog.Info("bmr: no package list found, skipping package reinstall")
	return nil
}

func (r *linuxRestorer) reinstallDpkg(listPath string) error {
	slog.Info("bmr: reinstalling packages via dpkg", "list", listPath)

	setCmd := exec.Command("bash", "-c",
		fmt.Sprintf("dpkg --set-selections < %s", listPath))
	if output, err := setCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("dpkg --set-selections: %s: %w", string(output), err)
	}

	installCmd := exec.Command("apt-get", "dselect-upgrade", "-y")
	if output, err := installCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("apt-get dselect-upgrade: %s: %w", string(output), err)
	}

	slog.Info("bmr: dpkg package restore complete")
	return nil
}

func (r *linuxRestorer) reinstallDnf(listPath string) error {
	slog.Info("bmr: reinstalling packages via dnf", "list", listPath)

	data, err := os.ReadFile(listPath)
	if err != nil {
		return fmt.Errorf("read rpm list: %w", err)
	}

	packages := strings.Fields(strings.TrimSpace(string(data)))
	if len(packages) == 0 {
		return nil
	}

	args := append([]string{"install", "-y"}, packages...)
	cmd := exec.Command("dnf", args...)
	if output, runErr := cmd.CombinedOutput(); runErr != nil {
		return fmt.Errorf("dnf install: %s: %w", string(output), runErr)
	}

	slog.Info("bmr: dnf package restore complete", "packages", len(packages))
	return nil
}

// restoreServices re-enables systemd services.
func (r *linuxRestorer) restoreServices(stagingDir string) error {
	listPath := filepath.Join(stagingDir, "services_enabled.txt")
	if _, err := os.Stat(listPath); os.IsNotExist(err) {
		return nil
	}

	data, err := os.ReadFile(listPath)
	if err != nil {
		return fmt.Errorf("read service list: %w", err)
	}

	services := strings.Fields(strings.TrimSpace(string(data)))
	for _, svc := range services {
		cmd := exec.Command("systemctl", "enable", svc)
		if output, runErr := cmd.CombinedOutput(); runErr != nil {
			slog.Warn("bmr: failed to enable service",
				"service", svc, "error", runErr.Error(), "output", string(output))
		}
	}

	slog.Info("bmr: systemd services restored", "count", len(services))
	return nil
}

// restoreFirewall applies saved iptables rules.
func (r *linuxRestorer) restoreFirewall(stagingDir string) error {
	rulesPath := filepath.Join(stagingDir, "iptables_rules")
	if _, err := os.Stat(rulesPath); os.IsNotExist(err) {
		return nil
	}

	cmd := exec.Command("bash", "-c",
		fmt.Sprintf("iptables-restore < %s", rulesPath))
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("iptables-restore: %s: %w", string(output), err)
	}

	slog.Info("bmr: firewall rules restored")
	return nil
}

// restoreCrontabs restores crontab files from backup.
func (r *linuxRestorer) restoreCrontabs(stagingDir string) error {
	cronDir := filepath.Join(stagingDir, "crontabs")
	if _, err := os.Stat(cronDir); os.IsNotExist(err) {
		return nil
	}

	entries, err := os.ReadDir(cronDir)
	if err != nil {
		return fmt.Errorf("read crontab dir: %w", err)
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		src := filepath.Join(cronDir, entry.Name())
		dst := filepath.Join("/var/spool/cron/crontabs", entry.Name())

		data, readErr := os.ReadFile(src)
		if readErr != nil {
			slog.Warn("bmr: read crontab failed", "user", entry.Name(), "error", readErr.Error())
			continue
		}
		if writeErr := os.WriteFile(dst, data, 0o600); writeErr != nil {
			slog.Warn("bmr: write crontab failed", "user", entry.Name(), "error", writeErr.Error())
			continue
		}
		slog.Info("bmr: crontab restored", "user", entry.Name())
	}
	return nil
}
