package helper

import (
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"golang.org/x/sys/windows/registry"
)

func migrateLegacyPlatform() {
	stopHelperLegacy()

	// Remove old registry autostart key ("BreezeHelper", not "BreezeAssist")
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, registryKey, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer key.Close()
	_ = key.DeleteValue("BreezeHelper")
}

func stopHelperLegacy() {
	_ = runHelperCommand("taskkill", "/F", "/IM", "Breeze Helper.exe")
	_ = runHelperCommand("taskkill", "/F", "/IM", "breeze-helper.exe")
}

func migrationTargets() ([]string, error) {
	sessionID := sessionbroker.GetConsoleSessionID()
	if sessionID == "" || sessionID == "0" {
		return nil, nil
	}
	return []string{sessionID}, nil
}

func prepareSessionDir(path, sessionKey string) error {
	return nil
}
