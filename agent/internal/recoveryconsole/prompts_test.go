package recoveryconsole

import (
	"os"
	"strings"
	"testing"
)

// KIT W04b proof (2026-09-12): after "Restored. Rebooting in 10 s (press any
// key to stay)." the console sat there for good. readOneKey drove the
// countdown with `stty -icanon min 0 time N` but ran stty with Stdin=nil, so
// stty configured /dev/null instead of the console; the tty stayed canonical
// and os.Stdin.Read blocked until a newline that never came. CI never sees
// this path (breeze.ci=1 skips the countdown). Every stty invocation must
// target the console, i.e. the process's own stdin.
func TestSttyCommandTargetsConsoleStdin(t *testing.T) {
	for _, args := range [][]string{
		{"-echo", "-icanon", "min", "0", "time", "10"},
		{"sane"},
	} {
		cmd := sttyCommand(args...)
		if cmd.Stdin != os.Stdin {
			t.Fatalf("stty %s: Stdin = %v, want os.Stdin (otherwise stty acts on /dev/null and the countdown never times out)", strings.Join(args, " "), cmd.Stdin)
		}
		if got := strings.Join(cmd.Args[1:], " "); got != strings.Join(args, " ") {
			t.Fatalf("stty args = %q, want %q", got, strings.Join(args, " "))
		}
	}
}
