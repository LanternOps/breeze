//go:build windows

package hwhealth

import "context"

func newWinPD(remembered map[string]string) Source {
	return &source{
		kind: "windows_physical_disk",
		tier: TierDisk,
		detect: func(context.Context) Availability {
			return Availability{Path: "powershell.exe", Available: true}
		},
		collect: func(ctx context.Context, a Availability) (Result, error) {
			return collectWinPD(ctx, runPowerShell, remembered)
		},
	}
}
