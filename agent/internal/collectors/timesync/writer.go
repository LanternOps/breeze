package timesync

import (
	"context"
	"fmt"
	"strings"
)

type Writer interface {
	Manual(context.Context, []string, bool) error
	Hierarchy(context.Context) error
	Poll(context.Context, int) error
	Update(context.Context) error
	Automatic(context.Context) error
	Start(context.Context) error
	Resync(context.Context) (int, error)
	ZoneExists(string) error
	Timezone(context.Context, string) error
}
type commandWriter struct {
	run   func(context.Context, string, ...string) (int, error)
	poll  func(int) error
	start func(context.Context) error
	zone  func(string) error
}

func (w *commandWriter) Manual(ctx context.Context, hosts []string, reliable bool) error {
	if len(hosts) < 1 || len(hosts) > 5 {
		return fmt.Errorf("invalid peer count")
	}
	peers := make([]string, len(hosts))
	for i, h := range hosts {
		if !IsValidNtpServerHost(h) {
			return fmt.Errorf("invalid NTP server host")
		}
		peers[i] = h + ",0x9"
	}
	args := []string{"/config", "/manualpeerlist:" + strings.Join(peers, " "), "/syncfromflags:manual"}
	if reliable {
		args = append(args, "/reliable:yes")
	}
	args = append(args, "/update")
	_, err := w.run(ctx, "w32tm.exe", args...)
	return err
}
func (w *commandWriter) Hierarchy(ctx context.Context) error {
	_, e := w.run(ctx, "w32tm.exe", "/config", "/syncfromflags:domhier", "/update")
	return e
}
func (w *commandWriter) Update(ctx context.Context) error {
	_, e := w.run(ctx, "w32tm.exe", "/config", "/update")
	return e
}
func (w *commandWriter) Automatic(ctx context.Context) error {
	_, e := w.run(ctx, "sc.exe", "config", "W32Time", "start=", "auto")
	return e
}
func (w *commandWriter) Resync(ctx context.Context) (int, error) {
	return w.run(ctx, "w32tm.exe", "/resync", "/rediscover")
}
func (w *commandWriter) Poll(ctx context.Context, n int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if n < 900 || n > 86400 {
		return fmt.Errorf("invalid poll seconds")
	}
	return w.poll(n)
}
func (w *commandWriter) Start(ctx context.Context) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	return w.start(ctx)
}
func (w *commandWriter) ZoneExists(id string) error {
	if !zoneSyntax(id) {
		return fmt.Errorf("invalid timezone ID")
	}
	return w.zone(id)
}
func (w *commandWriter) Timezone(ctx context.Context, id string) error {
	if e := w.ZoneExists(id); e != nil {
		return e
	}
	_, e := w.run(ctx, "tzutil.exe", "/s", id)
	return e
}
