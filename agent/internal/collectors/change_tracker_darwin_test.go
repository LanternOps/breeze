//go:build darwin

package collectors

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestParseDarwinCrontabTruncatesCommand(t *testing.T) {
	t.Parallel()

	output := "0 * * * * /usr/local/bin/" + strings.Repeat("a", collectorStringLimit+10) + "\n"
	tasks := parseDarwinCrontab(output)
	if len(tasks) != 1 {
		t.Fatalf("expected 1 task, got %d", len(tasks))
	}
	if !strings.Contains(tasks[0].Command, "[truncated]") {
		t.Fatalf("expected truncated command, got %q", tasks[0].Command)
	}
}

// stubDarwinCrontabList points the crontab runner at a real `sh -c script`
// subprocess so the collector sees genuine *exec.ExitError values (with
// Stderr populated by runCollectorOutputWithContext) and genuine timeouts.
func stubDarwinCrontabList(t *testing.T, timeout time.Duration, script string) {
	t.Helper()
	runner := darwinCrontabRunner(func(ctx context.Context) ([]byte, error) {
		return runCollectorOutputWithContext(ctx, timeout, "sh", "-c", script)
	})
	darwinCrontabListOverride.Store(&runner)
	t.Cleanup(func() { darwinCrontabListOverride.Store(nil) })
}

func TestCollectScheduledTasksNoCrontabStderrIsEmpty(t *testing.T) {
	stubDarwinCrontabList(t, 5*time.Second, `echo "crontab: no crontab for root" >&2; exit 1`)

	tasks, err := (&ChangeTrackerCollector{}).collectScheduledTasks(context.Background())
	if err != nil {
		t.Fatalf("expected no error for missing crontab, got %v", err)
	}
	if tasks == nil || len(tasks) != 0 {
		t.Fatalf("expected empty non-nil task list, got %#v", tasks)
	}
}

func TestCollectScheduledTasksNoCrontabStderrIsCaseInsensitive(t *testing.T) {
	stubDarwinCrontabList(t, 5*time.Second, `echo "crontab: No Crontab for admin" >&2; exit 1`)

	tasks, err := (&ChangeTrackerCollector{}).collectScheduledTasks(context.Background())
	if err != nil {
		t.Fatalf("expected no error for missing crontab, got %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("expected empty task list, got %#v", tasks)
	}
}

func TestCollectScheduledTasksSilentExitOneIsEmpty(t *testing.T) {
	stubDarwinCrontabList(t, 5*time.Second, `exit 1`)

	tasks, err := (&ChangeTrackerCollector{}).collectScheduledTasks(context.Background())
	if err != nil {
		t.Fatalf("expected no error for silent exit 1, got %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("expected empty task list, got %#v", tasks)
	}
}

func TestCollectScheduledTasksParsesCrontab(t *testing.T) {
	stubDarwinCrontabList(t, 5*time.Second, `printf '# comment\n*/5 * * * * /usr/local/bin/backup.sh --full\n'`)

	tasks, err := (&ChangeTrackerCollector{}).collectScheduledTasks(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("expected 1 task, got %#v", tasks)
	}
	if tasks[0].Name != "backup.sh" || tasks[0].Schedule != "*/5 * * * *" ||
		tasks[0].Command != "/usr/local/bin/backup.sh --full" || tasks[0].Path != "user-crontab:2" {
		t.Fatalf("unexpected parsed task: %#v", tasks[0])
	}
}

func TestCollectScheduledTasksTimeoutIsError(t *testing.T) {
	stubDarwinCrontabList(t, 100*time.Millisecond, `exec sleep 5`)

	tasks, err := (&ChangeTrackerCollector{}).collectScheduledTasks(context.Background())
	if err == nil {
		t.Fatalf("expected timeout error, got tasks %#v", tasks)
	}
	if !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout error, got %v", err)
	}
}

func TestCollectScheduledTasksOtherFailuresAreErrors(t *testing.T) {
	cases := map[string]string{
		"exit 1 with unrelated stderr":   `echo "crontab: Operation not permitted" >&2; exit 1`,
		"exit 1 with stdout but no text": `echo "partial"; exit 1`,
		"exit 2 with no-crontab text":    `echo "crontab: no crontab for root" >&2; exit 2`,
		"exit 2 silent":                  `exit 2`,
	}
	for name, script := range cases {
		t.Run(name, func(t *testing.T) {
			stubDarwinCrontabList(t, 5*time.Second, script)

			tasks, err := (&ChangeTrackerCollector{}).collectScheduledTasks(context.Background())
			if err == nil {
				t.Fatalf("expected error, got tasks %#v", tasks)
			}
		})
	}
}
