package patching

import "github.com/breeze-rmm/agent/internal/logging"

// Package logger. Intentionally untagged: it used to be declared in windows.go
// behind //go:build windows, which was fine only while every file that logged
// was also Windows-only. reboot_manager.go (#3197) is untagged, so the
// declaration has to be too or the linux/darwin build loses `log`.
var log = logging.L("patching")
