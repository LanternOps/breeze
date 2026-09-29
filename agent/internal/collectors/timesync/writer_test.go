package timesync

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestManagementWriterArgv(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name string
		call func(Writer) error
		want []string
	}{
		{"manual", func(w Writer) error { return w.Manual(ctx, []string{"time.cloudflare.com", "pool.ntp.org"}, false) }, []string{"w32tm.exe", "/config", "/manualpeerlist:time.cloudflare.com,0x9 pool.ntp.org,0x9", "/syncfromflags:manual", "/update"}},
		{"root-pdc", func(w Writer) error { return w.Manual(ctx, []string{"pool.ntp.org"}, true) }, []string{"w32tm.exe", "/config", "/manualpeerlist:pool.ntp.org,0x9", "/syncfromflags:manual", "/reliable:yes", "/update"}},
		{"domain", func(w Writer) error { return w.Hierarchy(ctx) }, []string{"w32tm.exe", "/config", "/syncfromflags:domhier", "/update"}},
		{"update", func(w Writer) error { return w.Update(ctx) }, []string{"w32tm.exe", "/config", "/update"}},
		{"auto", func(w Writer) error { return w.Automatic(ctx) }, []string{"sc.exe", "config", "W32Time", "start=", "auto"}},
		{"resync", func(w Writer) error { _, e := w.Resync(ctx); return e }, []string{"w32tm.exe", "/resync", "/rediscover"}},
		{"zone", func(w Writer) error { return w.Timezone(ctx, "Eastern Standard Time") }, []string{"tzutil.exe", "/s", "Eastern Standard Time"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			w := &commandWriter{run: func(_ context.Context, name string, args ...string) (int, error) {
				got = append([]string{name}, args...)
				return 0, nil
			}, zone: func(string) error { return nil }}
			if err := tc.call(w); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("argv=%q want=%q", got, tc.want)
			}
		})
	}
}
func TestManagementWriterRejectsHostsBeforeExec(t *testing.T) {
	_, invalid := hostFixture(t)
	for _, host := range invalid {
		t.Run(host, func(t *testing.T) {
			calls := 0
			w := &commandWriter{run: func(context.Context, string, ...string) (int, error) { calls++; return 0, nil }}
			if err := w.Manual(context.Background(), []string{host}, false); err == nil {
				t.Fatal("invalid host accepted")
			}
			if calls != 0 {
				t.Fatal("exec called for invalid host")
			}
		})
	}
}
func TestManagementWriterRegistrySCMAndFailures(t *testing.T) {
	poll, starts, execs := 0, 0, 0
	w := &commandWriter{run: func(context.Context, string, ...string) (int, error) { execs++; return 7, errors.New("exec failed") },
		poll: func(n int) error { poll = n; return nil }, start: func(context.Context) error { starts++; return nil },
		zone: func(string) error { return errors.New("unknown zone") }}
	if err := w.Poll(context.Background(), 3600); err != nil || poll != 3600 {
		t.Fatal(poll, err)
	}
	if err := w.Start(context.Background()); err != nil || starts != 1 {
		t.Fatal(starts, err)
	}
	if err := w.Timezone(context.Background(), "Missing Zone"); err == nil || execs != 0 {
		t.Fatal("zone validation did not precede exec")
	}
	if code, err := w.Resync(context.Background()); code != 7 || err == nil {
		t.Fatal(code, err)
	}
	if err := w.Poll(context.Background(), 899); err == nil {
		t.Fatal("invalid poll")
	}
	c, cancel := context.WithCancel(context.Background())
	cancel()
	if err := w.Start(c); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}
