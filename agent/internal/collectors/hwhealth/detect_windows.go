//go:build windows

package hwhealth

import (
	"os"
	"path/filepath"
)

func wellKnownDirs() []string {
	dirs := []string{}
	for _, key := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
		root := os.Getenv(key)
		if root == "" {
			continue
		}
		for _, suffix := range []string{
			`Dell\SysMgt\oma\bin`,
			`Dell\SysMgt\iDRAC Tools`,
			`Smart Storage Administrator\ssacli\bin`,
			`Compaq\Hpacucli\Bin`,
			`Adaptec\maxView Storage Manager`,
			`smartmontools\bin`,
		} {
			dirs = append(dirs, filepath.Join(root, suffix))
		}
	}
	return append(dirs, `C:\storcli`, `C:\perccli`, `C:\MegaCli`)
}
