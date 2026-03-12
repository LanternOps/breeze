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
func installPackage(msiPath, _ string) error {
	out, err := exec.Command("msiexec", "/i", msiPath, "/qn", "/norestart").CombinedOutput()
	if err != nil {
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
	out, err := exec.Command("tasklist", "/FI", "IMAGENAME eq Breeze Helper.exe", "/NH").Output()
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(out)), "breeze helper.exe")
}

func stopHelper() error {
	return exec.Command("taskkill", "/F", "/IM", "Breeze Helper.exe").Run()
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
