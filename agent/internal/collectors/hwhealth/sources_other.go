//go:build !linux

package hwhealth

import "runtime"

func remainingSources(dirs []string) []Source {
	if runtime.GOOS != "windows" {
		return nil
	}
	return []Source{newMegaCLI(dirs), newSSACLI(dirs), newARCCONF(dirs), newOMReport(dirs)}
}
