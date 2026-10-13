//go:build !linux && !windows

package workloads

import "context"

func dockerLiveness() func(context.Context) liveness { return nil }
func podmanLiveness() func(context.Context) liveness { return nil }
