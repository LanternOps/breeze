//go:build !linux

package syscleanup

// probeWritable is Linux-only; the Linux actions are never constructed
// elsewhere, so this stub exists purely so linux.go stays untagged and its
// argv builders and parsers are exercised by `go test ./...` on every runner.
func probeWritable(string) (bool, string) { return true, "" }
