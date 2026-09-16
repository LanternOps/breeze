package networkcontext

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"time"
)

var ErrUnsupported = errors.New("unsupported capability")
var ErrMalformed = errors.New("malformed OS evidence")
var ErrLimit = errors.New("collection limit exceeded")

func classifyReadError(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "timeout"
	case errors.Is(err, os.ErrPermission):
		return "permission_denied"
	case errors.Is(err, ErrUnsupported):
		return "unsupported"
	case errors.Is(err, ErrLimit):
		return "limit_exceeded"
	default:
		return "malformed"
	}
}
func finishSection[T any](s Section[T], kind, key string, limit int, err error) Section[T] {
	s.Kind, s.ContextKey = kind, key
	if s.Rows == nil {
		s.Rows = []T{}
	}
	if err != nil {
		s.ReasonCode = classifyReadError(err)
		if len(s.Rows) > 0 {
			s.Outcome = Partial
		} else if errors.Is(err, ErrUnsupported) {
			s.Outcome = Unsupported
		} else {
			s.Outcome = Failed
		}
	}
	if s.Outcome == "" {
		s.Outcome = Complete
	}
	if len(s.Rows) > limit {
		s.OmittedRowCount += len(s.Rows) - limit
		s.Rows = s.Rows[:limit]
		s.Outcome = Partial
		s.ReasonCode = "limit_exceeded"
	}
	s.RowCount = len(s.Rows)
	return s
}

// Collect serializes native reads, retains completed sections on cancellation,
// and emits explicit failures for all remaining sections. Readers must honor ctx.
func Collect(parent context.Context, reader Reader) (Snapshot, error) {
	if reader == nil {
		return Snapshot{}, errors.New("nil network context reader")
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	out := Snapshot{CapturedAt: time.Now().UTC(), Capabilities: reader.Capabilities()}
	manifest, err := reader.Contexts(ctx)
	if err != nil {
		manifest.Outcome = Partial
		if len(manifest.Contexts) == 0 {
			manifest.Outcome = Failed
		}
	}
	if manifest.Contexts == nil {
		manifest.Contexts = []Context{}
	}
	sort.Slice(manifest.Contexts, func(i, j int) bool { return manifest.Contexts[i].ContextKey < manifest.Contexts[j].ContextKey })
	if len(manifest.Contexts) > 128 {
		manifest.Contexts = manifest.Contexts[:128]
		manifest.Outcome = Partial
	}
	out.ContextManifest = manifest
	var errs []error
	if err != nil {
		errs = append(errs, err)
	}
	seen := map[string]bool{}
	for _, scope := range manifest.Contexts {
		if scope.ContextKey == "" || seen[scope.ContextKey] {
			return Snapshot{}, fmt.Errorf("context enumeration: %w", ErrMalformed)
		}
		seen[scope.ContextKey] = true
		a, e := readSection(ctx, scope, reader.Interfaces)
		out.Interfaces = append(out.Interfaces, finishSection(a, "interfaces", scope.ContextKey, 128, e))
		if e != nil {
			errs = append(errs, e)
		}

		d, e := readSection(ctx, scope, reader.Resolvers)
		out.Resolvers = append(out.Resolvers, finishSection(d, "resolvers", scope.ContextKey, 128, e))
		if e != nil {
			errs = append(errs, e)
		}
		routeBudget, ruleBudget, neighborBudget := 2048, 512, 4096
		for _, family := range scope.Families {
			if family != "ipv4" && family != "ipv6" {
				return Snapshot{}, ErrMalformed
			}
			scoped := Context{ContextKey: scope.ContextKey, Families: []string{family}}
			r, e := readSection(ctx, scoped, reader.Routes)
			r.AddressFamily = family
			// Keep default/connected reachability evidence before less important
			// destination-specific rows when the context budget is exhausted.
			sort.SliceStable(r.Rows, func(i, j int) bool { return routePriority(r.Rows[i]) < routePriority(r.Rows[j]) })
			r = finishSection(r, "routes", scope.ContextKey, routeBudget, e)
			routeBudget -= len(r.Rows)
			out.Routes = append(out.Routes, r)
			if e != nil {
				errs = append(errs, e)
			}
			p, e := readSection(ctx, scoped, reader.Rules)
			p.AddressFamily = family
			p = finishSection(p, "rules", scope.ContextKey, ruleBudget, e)
			ruleBudget -= len(p.Rows)
			out.Rules = append(out.Rules, p)
			if e != nil {
				errs = append(errs, e)
			}
			n, e := readSection(ctx, scoped, reader.Neighbors)
			n.AddressFamily = family
			n = finishSection(n, "neighbors", scope.ContextKey, neighborBudget, e)
			neighborBudget -= len(n.Rows)
			out.Neighbors = append(out.Neighbors, n)
			if e != nil {
				errs = append(errs, e)
			}
		}
	}
	return out, errors.Join(errs...)
}
func readSection[T any](ctx context.Context, scope Context, read func(context.Context, Context) (Section[T], error)) (Section[T], error) {
	if err := ctx.Err(); err != nil {
		return Section[T]{}, err
	}
	return read(ctx, scope)
}

func routePriority(row RouteRow) int {
	if row.DestinationPrefix == "0.0.0.0/0" || row.DestinationPrefix == "::/0" {
		return 0
	}
	if len(row.NextHops) == 0 {
		return 1
	}
	for _, hop := range row.NextHops {
		if hop.Address != nil {
			return 2
		}
	}
	return 1
}
