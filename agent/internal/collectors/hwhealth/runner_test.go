package hwhealth

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRunnerChild(t *testing.T) {
	args := os.Args
	for i, a := range args {
		if a != "hw-child" {
			continue
		}
		switch args[i+1] {
		case "exit":
			fmt.Print(`{"smart_status":{"passed":false}}`)
			os.Exit(8)
		case "hang":
			time.Sleep(time.Hour)
		case "overflow":
			fmt.Print(strings.Repeat("x", 4*1024*1024+1))
		}
		os.Exit(0)
	}
}

func TestRunner(t *testing.T) {
	for _, tc := range []struct {
		mode     string
		code     int
		bad, cap bool
	}{
		{"exit", 8, false, false},
		{"hang", -1, true, false},
		{"overflow", 0, true, true},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			d := 5 * time.Second
			if tc.mode == "hang" {
				d = 50 * time.Millisecond
			}
			start := time.Now()
			r, e := runTool(context.Background(), d, os.Args[0], "-test.run=TestRunnerChild", "--", "hw-child", tc.mode)
			if (e != nil) != tc.bad || r.Truncated != tc.cap {
				t.Fatalf("%+v %v", r, e)
			}
			if !tc.bad && (r.ExitCode != tc.code || !strings.Contains(string(r.Stdout), "smart_status")) {
				t.Fatal(r)
			}
			if len(r.Stdout) > 4*1024*1024 || time.Since(start) > 12*time.Second {
				t.Fatal("unbounded runner")
			}
		})
	}
}

func TestRunnerMissing(t *testing.T) {
	_, e := runTool(context.Background(), time.Second, "/nonexistent/hwhealth-tool")
	if e == nil {
		t.Fatal("spawn must fail")
	}
}
