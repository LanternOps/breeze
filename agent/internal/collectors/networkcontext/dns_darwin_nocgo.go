//go:build darwin && !cgo

package networkcontext

import "context"

func readNativeDNS(ctx context.Context) (ResolverSection, error) {
	return ReadScopedDNS(ctx, boundedRunner{})
}
