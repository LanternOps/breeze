package agentapp

import (
	"path/filepath"
	"runtime"
	"strings"

	"github.com/breeze-rmm/agent/internal/config"
)

// reclaimConfigDirFn is config.ReclaimConfigDir, swappable in tests.
var reclaimConfigDirFn = config.ReclaimConfigDir

// configFileInMachineDir reports whether cfgFile (the --config flag) names a
// file in the machine-wide config folder: empty (the default) or a path
// directly inside config.MachineConfigDir().
func configFileInMachineDir(cfgFile string) bool {
	if cfgFile == "" {
		return true
	}
	abs, err := filepath.Abs(cfgFile)
	if err != nil {
		return false
	}
	dir, machine := filepath.Clean(filepath.Dir(abs)), filepath.Clean(config.MachineConfigDir())
	if runtime.GOOS == "windows" {
		return strings.EqualFold(dir, machine)
	}
	return dir == machine
}
