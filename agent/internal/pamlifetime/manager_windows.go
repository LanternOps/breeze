//go:build windows

package pamlifetime

import "github.com/breeze-rmm/agent/internal/elevaccount"

func NewManager(store *Store) *lifecycleManager {
	// The frozen Manager contract returns one terminal result. The internal
	// observer proves received-before-verified ordering, but there is not yet a
	// production transport-safe second-result channel.
	return newLifecycleManager(store, &nativeWindowsPrimitives{}, elevaccount.NewVerified(), nil)
}
