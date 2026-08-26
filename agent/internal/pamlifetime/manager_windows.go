//go:build windows

package pamlifetime

import "github.com/breeze-rmm/agent/internal/elevaccount"

func NewManager(store *Store) *lifecycleManager {
	return newLifecycleManager(store, &nativeWindowsPrimitives{}, elevaccount.NewVerified(), nil)
}
