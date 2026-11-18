package procspawn

import (
	"context"
	"os"
	"os/exec"
	"reflect"
	"testing"
)

func writeFile(path, src string) error { return os.WriteFile(path, []byte(src), 0o600) }

// Unconfigured (every OS before the split, and all non-Linux), Command is
// exactly exec.Command.
func TestCommandMatchesExecWhenUnconfigured(t *testing.T) {
	got := Command("echo", "a", "b")
	want := exec.Command("echo", "a", "b")
	if got.Path != want.Path || !reflect.DeepEqual(got.Args, want.Args) || got.SysProcAttr != nil {
		t.Fatalf("Command = %+v / %v, want %+v / %v", got.Args, got.SysProcAttr, want.Args, want.SysProcAttr)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if c := CommandContext(ctx, "echo"); c.SysProcAttr != nil || c.Path != want.Path {
		t.Fatalf("CommandContext = %+v", c)
	}
	if Prepare(nil) != nil {
		t.Fatal("Prepare(nil) must be nil")
	}
}
