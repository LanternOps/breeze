//go:build !windows

package syscleanup

import "errors"

// Windows-only seam. The stubs exist so windows.go — which holds the handler
// allowlist, every argv builder and the DISM parser — stays untagged and is
// therefore exercised by `go test ./...` on the Linux CI runner, where the
// Windows job does not run internal/syscleanup at all.
func presentVolumeCachesImpl() ([]string, error) { return nil, errors.New("not windows") }

func setStateFlagsImpl(string, uint32) error { return errors.New("not windows") }

func handlerDisplayNameImpl(string) string { return "" }

func expandWindowsPathImpl(path string) string { return path }

func readDOCachePolicyImpl() string { return "" }
