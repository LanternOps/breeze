package security

import (
	"context"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/yarascan"
)

// syntheticMarker is plain text that only the synthetic rule below matches;
// no antivirus product treats it as anything.
const syntheticMarker = "breeze synthetic scan marker 5c1d0e"

type syntheticFetcher struct{ b *yarascan.Bundle }

func (f syntheticFetcher) Fetch(context.Context, yarascan.RuleSetRef) (*yarascan.Bundle, *yarascan.RuleSetError) {
	return f.b, nil
}

// syntheticMatcher compiles one rule that matches syntheticMarker.
func syntheticMatcher(t *testing.T) yarascan.Matcher {
	t.Helper()
	b := &yarascan.Bundle{
		Format: yarascan.BundleFormat, V: yarascan.BundleFormatVersion,
		RuleSetID: "7c0b1f9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f", Version: 1,
		Rules: []yarascan.BundleRule{{
			ID: "0f1e2d3c-4b5a-4968-8776-655443322110", Name: "synthetic_marker", Severity: "high",
			Source: `rule synthetic_marker { strings: $a = "breeze synthetic scan marker 5c1d0e" condition: $a }`,
		}},
	}
	refs := []yarascan.RuleSetRef{{ID: b.RuleSetID, Version: 1, SHA256: strings.Repeat("d", 64)}}
	m, errs := yarascan.LoadMatcher(context.Background(), refs, syntheticFetcher{b}, nil)
	if m == nil {
		t.Fatalf("synthetic matcher unavailable: %+v", errs)
	}
	t.Cleanup(m.Close)
	return m
}
