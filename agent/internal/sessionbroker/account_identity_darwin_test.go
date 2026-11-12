//go:build darwin

package sessionbroker

import (
	"os"
	"strconv"
	"testing"
)

// The Open Directory fallback (used when os/user cannot answer, as in a
// build without cgo) resolves the running account in both directions.
func TestSystemAccountEntryUsesOpenDirectory(t *testing.T) {
	uid := strconv.Itoa(os.Getuid())
	name, gotUID, err := systemAccountEntry(uid)
	if err != nil || name == "" || gotUID != uid {
		t.Fatalf("systemAccountEntry(%s) = %q, %q, %v", uid, name, gotUID, err)
	}
	byName, byNameUID, err := systemAccountEntry(name)
	if err != nil || byName != name || byNameUID != uid {
		t.Fatalf("systemAccountEntry(%q) = %q, %q, %v", name, byName, byNameUID, err)
	}
	if _, _, err := systemAccountEntry("breeze-test-no-such-account"); err == nil {
		t.Fatal("an unknown account resolved")
	}
}
