package executor

import "testing"

func BenchmarkNewSecurityValidator(b *testing.B) {
	for b.Loop() {
		NewSecurityValidator(SecurityLevelStrict)
	}
}

func BenchmarkValidate(b *testing.B) {
	v := NewSecurityValidator(SecurityLevelStrict)
	script := "Get-Service | Where-Object Status -eq 'Running'\nGet-Process | Sort-Object CPU -Descending | Select-Object -First 5\n"
	if err := v.Validate(script); err != nil {
		b.Fatal(err)
	}
	for b.Loop() {
		_ = v.Validate(script)
	}
}
