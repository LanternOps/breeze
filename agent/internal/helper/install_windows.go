package helper

import (
	"fmt"
	"os/exec"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const registryKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Run`
const registryValue = "BreezeHelper"

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
