package tccdiag

import (
	"fmt"
	"log/slog"
)

// flattenAttrs renders slog key/value pairs the way the log shipper does:
// groups become dotted keys.
func flattenAttrs(args []any) map[string]string {
	out := map[string]string{}
	r := slog.Record{}
	r.Add(args...)
	var walk func(prefix string, a slog.Attr)
	walk = func(prefix string, a slog.Attr) {
		key := a.Key
		if prefix != "" {
			key = prefix + "." + a.Key
		}
		v := a.Value.Resolve()
		if v.Kind() == slog.KindGroup {
			for _, g := range v.Group() {
				walk(key, g)
			}
			return
		}
		out[key] = fmt.Sprint(v.Any())
	}
	r.Attrs(func(a slog.Attr) bool { walk("", a); return true })
	return out
}
