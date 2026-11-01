// breeze-isolation-recovery is the independently runnable containment recovery
// skeleton. It must not link the main agent's configuration or update stack.
//
// Exit codes: 0 = success; 1 = unsupported platform / operation unavailable;
// 2 = invalid command or arguments. W1g will add effect-specific failure codes
// when the platform recovery operations are implemented.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/breeze-rmm/agent/internal/isolation"
)

// Overridden by the release build with -ldflags '-X main.version=...'.
var version = "dev"

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr io.Writer) int {
	invalid := func(message string) int { _, _ = fmt.Fprintln(stderr, message); return 2 }
	if len(args) == 0 {
		return invalid("a recovery subcommand is required")
	}
	name := args[0]
	switch name {
	case "--version":
		if len(args) != 1 {
			return invalid("--version accepts no arguments")
		}
		_, _ = fmt.Fprintln(stdout, version)
		return 0
	case "self-test":
		if len(args) != 1 {
			return invalid("self-test accepts no arguments")
		}
		capability := isolation.NewPlatformIsolator().Capability()
		if capability.Version < 1 {
			_, _ = fmt.Fprintln(stderr, capability.UnsupportedReason)
			return 1
		}
		return 0
	case "expire-check", "boot-apply", "rollback-if-uncommitted", "release-all":
	default:
		return invalid("unknown recovery subcommand")
	}

	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	// Do not echo arbitrary input values from the flag parser into logs.
	flags.SetOutput(io.Discard)
	dataDir := flags.String("data-dir", "", "Agent state directory")
	var attempt, reason string
	if name == "rollback-if-uncommitted" {
		flags.StringVar(&attempt, "attempt", "", "Provisional attempt ID")
	}
	if name == "release-all" {
		flags.StringVar(&reason, "reason", "", "Release reason")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return invalid("invalid recovery arguments")
	}
	if flags.NArg() != 0 {
		return invalid("unexpected positional arguments")
	}
	if strings.TrimSpace(*dataDir) == "" {
		return invalid("--data-dir is required")
	}
	if name == "rollback-if-uncommitted" && strings.TrimSpace(attempt) == "" {
		return invalid("--attempt is required")
	}
	if name == "release-all" && strings.TrimSpace(reason) == "" {
		return invalid("--reason is required")
	}

	isolator := isolation.NewPlatformIsolator()
	if name == "rollback-if-uncommitted" || name == "release-all" || isolator.Capability().Version < 1 {
		// No exported manager API provides an attempt-fenced rollback or an
		// unconditional orphan release. Do not substitute Startup/LocalRelease:
		// either could affect a different attempt or lose the requested reason.
		_, _ = fmt.Fprintln(stderr, "not implemented on this platform yet (W1g)")
		return 1
	}
	manager := isolation.NewManager(isolation.ManagerDeps{
		DataDir: *dataDir, Isolator: isolator,
		Scheduler: isolation.NewPlatformScheduler(*dataDir),
	})
	switch name {
	case "boot-apply":
		manager.Startup(context.Background())
	case "expire-check":
		manager.Tick(context.Background())
	}
	// Startup/Tick currently return no result. W1g must add recovery-specific
	// confirmation before this skeleton can claim successful OS recovery.
	_, _ = fmt.Fprintln(stderr, "recovery confirmation not implemented on this platform yet (W1g)")
	return 1
}
