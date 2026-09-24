package hwhealth

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestBMCCommands(t *testing.T) {
	for _, kind := range []Kind{"ipmi", "racadm", "hponcfg"} {
		t.Run(string(kind), func(t *testing.T) {
			calls := [][]string{}
			exported := ""
			runner := func(ctx context.Context, timeout time.Duration, path string, args ...string) (execResult, error) {
				if timeout != 20*time.Second {
					t.Fatal(timeout)
				}
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("missing cycle deadline")
				}
				calls = append(calls, append([]string{}, args...))
				if kind == "hponcfg" {
					if len(args) != 2 || args[0] != "-w" {
						t.Fatal(args)
					}
					exported = args[1]
					if err := os.WriteFile(exported, fixture(t, "hponcfg", "export.txt"), 0600); err != nil {
						t.Fatal(err)
					}
					return execResult{}, nil
				}
				file := "lan.txt"
				if len(calls) == 2 {
					file = "info.txt"
				}
				if kind == "racadm" {
					file = "nic.txt"
					if len(calls) == 2 {
						file = "version.txt"
					}
				}
				return execResult{Stdout: fixture(t, string(kind), file)}, nil
			}
			src := newBMC(kind, nil, runner)
			result, err := src.Collect(context.Background(), Availability{Available: true, Path: "fixture"})
			if err != nil || !result.Complete || len(result.Components) != 1 || src.Name() != kind || src.Tier() != TierRAID {
				t.Fatal(result, err)
			}
			if kind == "ipmi" && !reflect.DeepEqual(calls, [][]string{{"lan", "print", "1"}, {"mc", "info"}}) {
				t.Fatal(calls)
			}
			if kind == "racadm" && !reflect.DeepEqual(calls, [][]string{{"getniccfg"}, {"getversion"}}) {
				t.Fatal(calls)
			}
			if exported != "" {
				if _, err := os.Stat(filepath.Dir(exported)); !os.IsNotExist(err) {
					t.Fatal("export directory retained", err)
				}
			}
		})
	}
}

func TestBMCCommandFailures(t *testing.T) {
	for _, variant := range []string{"driver", "exit", "truncated", "timeout", "export-failed"} {
		t.Run(variant, func(t *testing.T) {
			path := ""
			kind := Kind("ipmi")
			if variant == "export-failed" {
				kind = "hponcfg"
			}
			src := newBMC(kind, nil, func(_ context.Context, _ time.Duration, _ string, args ...string) (execResult, error) {
				switch variant {
				case "driver":
					return execResult{ExitCode: 1, Stderr: fixture(t, "ipmi", "driver-missing.txt")}, nil
				case "exit":
					return execResult{ExitCode: 1, Stderr: []byte("sensitive output")}, nil
				case "truncated":
					return execResult{Truncated: true}, nil
				case "timeout":
					return execResult{}, context.DeadlineExceeded
				default:
					path = args[1]
					return execResult{}, errors.New("failure")
				}
			})
			r, err := src.Collect(context.Background(), Availability{Available: true, Path: "fixture"})
			if err == nil || len(r.Components) != 0 || r.Complete {
				t.Fatal(r, err)
			}
			if variant == "driver" && !errors.Is(err, errNoBMC) {
				t.Fatal(err)
			}
			if path != "" {
				if _, err := os.Stat(filepath.Dir(path)); !os.IsNotExist(err) {
					t.Fatal("failed export retained")
				}
			}
		})
	}
}
