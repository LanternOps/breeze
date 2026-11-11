package isolation

import (
	"strings"
	"testing"
)

// Ready must not trust a poll task that still points at the recovery binary
// but can no longer fire: disabled, trigger-stripped, or not run as SYSTEM.
func TestWindowsSchedulerReadyRejectsInertPollTask(t *testing.T) {
	mutations := map[string]func(string) string{
		"settings-disabled": func(x string) string {
			return strings.Replace(x, "<ExecutionTimeLimit>PT2M</ExecutionTimeLimit>\n    <Enabled>true</Enabled>", "<ExecutionTimeLimit>PT2M</ExecutionTimeLimit>\n    <Enabled>false</Enabled>", 1)
		},
		"boot-trigger-removed": func(x string) string {
			return strings.Replace(x, "<BootTrigger>\n      <Enabled>true</Enabled>\n    </BootTrigger>", "", 1)
		},
		"time-trigger-disabled": func(x string) string {
			return strings.Replace(x, "</StartBoundary>\n      <Enabled>true</Enabled>", "</StartBoundary>\n      <Enabled>false</Enabled>", 1)
		},
		"repetition-removed": func(x string) string {
			return strings.Replace(x, "<Interval>PT15M</Interval>", "<Interval>P1D</Interval>", 1)
		},
		"not-system": func(x string) string { return strings.Replace(x, "S-1-5-18", "S-1-5-32-545", 1) },
		"no-catch-up": func(x string) string {
			return strings.Replace(x, "<StartWhenAvailable>true</StartWhenAvailable>", "<StartWhenAvailable>false</StartWhenAvailable>", 1)
		},
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			s, tasks, _ := newFakeRecoveryScheduler(t)
			if err := s.EnsurePoll(); err != nil {
				t.Fatal(err)
			}
			decoded, err := decodeTaskXML(tasks[`\Breeze\IsolationPoll`])
			if err != nil {
				t.Fatal(err)
			}
			original := string(decoded)
			mutated := mutate(original)
			if mutated == original {
				t.Fatal("mutation did not apply")
			}
			tasks[`\Breeze\IsolationPoll`] = encodeTaskXML([]byte(mutated))
			if ok, _ := s.Ready(); ok {
				t.Fatal("ready with an inert poll task")
			}
		})
	}
}
