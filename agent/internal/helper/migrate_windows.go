package helper

import (
	"os/exec"

	"golang.org/x/sys/windows/registry"
)

func migrateLegacyPlatform() {
	// Kill old process
	_ = exec.Command("taskkill", "/F", "/IM", "Breeze Helper.exe").Run()

	// Remove old registry autostart key ("BreezeHelper", not "BreezeAssist")
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, registryKey, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer key.Close()
	_ = key.DeleteValue("BreezeHelper")
}
