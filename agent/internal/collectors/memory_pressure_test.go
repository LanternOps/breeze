package collectors

import "testing"

func TestParseMemoryPressureOutputAppleSiliconCapture(t *testing.T) {
	const output = `The system has 51539607552 (3145728 pages with a page size of 16384).
System-wide memory free percentage: 73%`

	total, free, err := parseMemoryPressureOutput(output)
	if err != nil {
		t.Fatalf("parseMemoryPressureOutput error: %v", err)
	}
	if total != 51539607552 {
		t.Fatalf("total = %d, want 51539607552", total)
	}
	if free != 73 {
		t.Fatalf("free = %.2f, want 73", free)
	}

	metrics := &SystemMetrics{}
	applyPressureAwareMemoryMetrics(metrics, total, free)
	if metrics.RAMPercent != 27 {
		t.Fatalf("RAMPercent = %.2f, want 27", metrics.RAMPercent)
	}
	if metrics.RAMUsedMB != 13271 {
		t.Fatalf("RAMUsedMB = %d, want 13271", metrics.RAMUsedMB)
	}
}

func TestParseMemoryPressureOutputIntelCapture(t *testing.T) {
	const output = `The system has 68719476736 (16777216 pages with a page size of 4096).
System-wide memory free percentage: 92%`

	total, free, err := parseMemoryPressureOutput(output)
	if err != nil {
		t.Fatalf("parseMemoryPressureOutput error: %v", err)
	}

	metrics := &SystemMetrics{}
	applyPressureAwareMemoryMetrics(metrics, total, free)
	if metrics.RAMPercent != 8 {
		t.Fatalf("RAMPercent = %.2f, want 8", metrics.RAMPercent)
	}
	if metrics.RAMUsedMB != 5242 {
		t.Fatalf("RAMUsedMB = %d, want 5242", metrics.RAMUsedMB)
	}
}

func TestParseMemoryPressureOutputDecimalFreePercent(t *testing.T) {
	const output = `The system has 68719476736 (16777216 pages with a page size of 4096).
System-wide memory free percentage: 91.5%`

	total, free, err := parseMemoryPressureOutput(output)
	if err != nil {
		t.Fatalf("parseMemoryPressureOutput error: %v", err)
	}

	metrics := &SystemMetrics{}
	applyPressureAwareMemoryMetrics(metrics, total, free)
	if metrics.RAMPercent != 8.5 {
		t.Fatalf("RAMPercent = %.2f, want 8.5", metrics.RAMPercent)
	}
	if metrics.RAMUsedMB != 5570 {
		t.Fatalf("RAMUsedMB = %d, want 5570", metrics.RAMUsedMB)
	}
}

func TestParseMemoryPressureOutputRejectsMalformedOutput(t *testing.T) {
	tests := []struct {
		name   string
		output string
	}{
		{name: "missing total", output: `System-wide memory free percentage: 92%`},
		{name: "missing percentage", output: `The system has 68719476736 (16777216 pages with a page size of 4096).`},
		{name: "zero total", output: `The system has 0 (0 pages with a page size of 4096).
System-wide memory free percentage: 92%`},
		{name: "percentage above 100", output: `The system has 68719476736 (16777216 pages with a page size of 4096).
System-wide memory free percentage: 120%`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, _, err := parseMemoryPressureOutput(tt.output); err == nil {
				t.Fatal("expected parse error")
			}
		})
	}
}
