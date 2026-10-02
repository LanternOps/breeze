package logging

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Every production process that starts a shipper must pass
// LevelOverridePath, or a set_log_level override silently never reaches it —
// which is how the desktop helper's WebRTC diagnostics stayed at warn while
// the operator asked for debug (#7416). This walks the agent source so a new
// shipper-owning binary cannot forget it.
func TestEveryInitShipperCallPassesLevelOverridePath(t *testing.T) {
	root := filepath.Join("..", "..")
	callRe := regexp.MustCompile(`logging\.InitShipper\(logging\.ShipperConfig\{`)

	var sites int
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "vendor", "testdata", "node_modules", ".git":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(src)
		for _, loc := range callRe.FindAllStringIndex(text, -1) {
			sites++
			end := strings.Index(text[loc[1]:], "})")
			if end < 0 {
				t.Errorf("%s: unterminated InitShipper literal", path)
				continue
			}
			if !strings.Contains(text[loc[1]:loc[1]+end], "LevelOverridePath: config.LogLevelOverridePath(),") {
				t.Errorf("%s: InitShipper call does not set LevelOverridePath: config.LogLevelOverridePath() (see #7416)", path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// agent service, user helper, desktop helper, backup helper.
	if sites < 4 {
		t.Fatalf("found only %d InitShipper call sites; the walk is not seeing the agent source", sites)
	}
}
