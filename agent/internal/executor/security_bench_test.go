package executor

import "testing"

func BenchmarkNewSecurityValidator(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		NewSecurityValidator(SecurityLevelStrict)
	}
}
