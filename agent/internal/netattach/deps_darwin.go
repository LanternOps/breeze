//go:build darwin

package netattach

import (
	"context"
	"sync"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

var osDeps = sync.OnceValue(func() deps {
	// The reader is built once per process: its argument only scopes the
	// interface keys it hands out, and keys must stay stable between reads.
	reader := networkcontext.NewReader("netattach")
	return deps{reader: reader, lookup: readerLookup(reader), resolve: systemResolve, bridged: darwinBridged}
})

// darwinBridged reads no bridge members in v1, so a macOS bridge (or virtual)
// row is never reported (plan contract note 2).
func darwinBridged(context.Context, []networkcontext.InterfaceRow) (map[string]bool, error) {
	return map[string]bool{}, nil
}
