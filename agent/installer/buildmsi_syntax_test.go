package installer

import (
	"regexp"
	"testing"
)

// In a double-quoted PowerShell string, "$name:" is read as a scope or drive
// qualified variable (like $env:PATH), so "$name: text" does not even parse
// ("Invalid variable reference ... Consider using ${}") and Windows PowerShell
// refuses the whole script. No Linux test can notice that by running the
// script, so this reads the text: write "${name}:" instead.
func TestBuildMsiHasNoVariableFollowedByAColon(t *testing.T) {
	ps1 := readBuildMsi(t)
	re := regexp.MustCompile(`\$[A-Za-z_][A-Za-z0-9_]*:\s`)
	if loc := re.FindStringIndex(ps1); loc != nil {
		t.Errorf("build-msi.ps1 has a variable directly followed by a colon (%q); write ${name}: so PowerShell can parse it", ps1[loc[0]:loc[1]])
	}
}
