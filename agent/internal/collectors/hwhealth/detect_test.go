package hwhealth

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestDetectionCache(t *testing.T) {
	n := 0
	d := detection{}
	now := time.Unix(1, 0)
	probe := func() Availability {
		n++
		return Availability{Available: true, Path: "gone"}
	}
	d.get(now, probe)
	d.get(now.Add(time.Minute), probe)
	if n != 1 {
		t.Fatal(n)
	}
	d.get(now.Add(time.Hour), probe)
	if n != 2 {
		t.Fatal(n)
	}
}

func TestExtraDirs(t *testing.T) {
	dir := t.TempDir()
	name := "breeze-hw-fixture-tool"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	p := filepath.Join(dir, name)
	if e := os.WriteFile(p, []byte("fixture"), 0700); e != nil {
		t.Fatal(e)
	}
	got, ok := lookupTool([]string{name}, []string{dir})
	if !ok || got != p {
		t.Fatalf("%s %v", got, ok)
	}
}
