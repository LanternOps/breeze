//go:build windows

package hwhealth

import (
	"context"
	"time"
)

// runPowerShell runs a static script through the bounded runner with UTF-8
// output. Only Windows sources call it.
func runPowerShell(ctx context.Context, timeout time.Duration, script string) (execResult, error) {
	return runTool(ctx, timeout, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;"+script)
}
