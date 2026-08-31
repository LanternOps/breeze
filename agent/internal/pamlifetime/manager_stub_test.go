//go:build !windows

package pamlifetime

import (
	"context"
	"path/filepath"
	"testing"
)

func TestStubManagerFailsClosedAndNeverAdvertisesV2(t *testing.T) {
	manager := NewManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")))
	if got := manager.ProtocolVersion(); got != 0 {
		t.Fatalf("protocol version = %d, want 0", got)
	}
	result := manager.Apply(context.Background(), validApply(1))
	if result.State != ResultFailed || result.FailureCode != FailureUnsupportedPlatform {
		t.Fatalf("result = %+v", result)
	}
	if _, ok := manager.store.Entry(testActuationID); !ok {
		t.Fatal("desired generation must be durable before unsupported OS action is reported")
	}
}
