package heartbeat

import (
	"context"
	"os"
	"testing"

	"github.com/breeze-rmm/agent/internal/systemrestore"
)

// TestMain points the createRestorePoint seam at an inert fake for the whole
// package, so no test — including a future one that forgets
// installCheckpointRecorder — can create a REAL System Restore point on a
// Windows CI runner. (A missing block on install_patches means legacy-enabled,
// so any test that drives handleInstallPatches would otherwise reach it.)
func TestMain(m *testing.M) {
	createRestorePoint = func(_ context.Context, req systemrestore.Request) systemrestore.Outcome {
		return systemrestore.Outcome{
			Status:    systemrestore.StatusUnsupported,
			RequestID: req.RequestID,
			Message:   "test default: real System Restore is never called from tests",
		}
	}
	os.Exit(m.Run())
}
