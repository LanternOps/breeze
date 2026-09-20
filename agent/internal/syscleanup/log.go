package syscleanup

import "github.com/breeze-rmm/agent/internal/logging"

// Package logger. Untagged on purpose: runner.go and catalog.go log on every
// platform, so declaring it in a build-tagged file would break the other two
// builds (the mistake internal/patching/log.go documents).
var log = logging.L("syscleanup")
