package helper

import (
	"fmt"
	"os/exec"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const registryKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`
const registryValue = "BreezeHelper"

func packageExtension() string { return ".msi" }

// installPackage runs the MSI installer silently.
// Exit code 3010 means success but reboot required — treated as success.
func installPackage(msiPath, _ string) error {
	cmd := exec.Command("msiexec", "/i", msiPath, "/qn", "/norestart")
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Exit code 3010 = ERROR_SUCCESS_REBOOT_REQUIRED
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 3010 {
			log.Info("MSI installed successfully (reboot required)", "msi", msiPath)
			return nil
		}
		return fmt.Errorf("msiexec: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	log.Info("MSI installed successfully", "msi", msiPath)
	return nil
}

func installAutoStart(binaryPath string) error {
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, registryKey, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("open registry key: %w", err)
	}
	defer key.Close()

	if err := key.SetStringValue(registryValue, binaryPath); err != nil {
		return fmt.Errorf("set registry value: %w", err)
	}

	log.Info("installed HKLM Run registry key", "value", registryValue)
	return nil
}

func isHelperRunning() bool {
	out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq breeze-helper.exe", "/NH").Output()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), "breeze-helper.exe")
}

func stopHelper() error {
	return exec.Command("taskkill", "/F", "/IM", "breeze-helper.exe").Run()
}

func removeAutoStart() error {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, registryKey, registry.SET_VALUE)
	if err != nil {
		return nil // key doesn't exist
	}
	defer key.Close()
	_ = key.DeleteValue(registryValue)
	return nil
}
