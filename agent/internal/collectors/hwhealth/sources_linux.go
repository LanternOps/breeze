//go:build linux

package hwhealth

func remainingSources(dirs []string) []Source {
	return []Source{newMegaCLI(dirs), newSSACLI(dirs), newARCCONF(dirs), newOMReport(dirs), newZFSSource(dirs)}
}
