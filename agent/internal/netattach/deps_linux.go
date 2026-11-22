//go:build linux

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
	return deps{reader: reader, lookup: readerLookup(reader), resolve: systemResolve, bridged: linuxBridged}
})

// linuxBridged is K2 on Linux: a bridge or virtual row has a physical uplink
// when one of its sysfs members is an ethernet or wifi link.
func linuxBridged(_ context.Context, rows []networkcontext.InterfaceRow) (map[string]bool, error) {
	out := make(map[string]bool, len(rows))
	for _, row := range rows {
		out[row.InterfaceKey] = networkcontext.LinuxBridgedUplink("/sys/class/net", row.Name)
	}
	return out, nil
}
