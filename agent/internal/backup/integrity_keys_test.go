package backup

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
)

// TestIntegrityControlKeysMatchAttestation: the restore-side expectation
// package and the attestation producer name every control object the same.
func TestIntegrityControlKeysMatchAttestation(t *testing.T) {
	roles := map[string]string{
		AttestationRoleManifest:            integrity.RoleManifest,
		AttestationRoleLayout:              integrity.RoleLayout,
		AttestationRoleSystemStateManifest: integrity.RoleSystemStateManifest,
	}
	for producerRole, restoreRole := range roles {
		if producerRole != restoreRole {
			t.Fatalf("role %q != %q", producerRole, restoreRole)
		}
		want, err := ControlObjectKey("snapshot-x", producerRole)
		if err != nil {
			t.Fatal(err)
		}
		got, err := integrity.ControlObjectKey("snapshot-x", restoreRole)
		if err != nil || got != want {
			t.Fatalf("%s: restore key %q, producer key %q (%v)", producerRole, got, want, err)
		}
	}
}
