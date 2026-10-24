//go:build windows

package tools

import "github.com/breeze-rmm/agent/internal/svcquery"

// platformServiceStatus queries the SCM by service key name, falling back to
// display name (svcquery). Exercised only in the owner lab (gates L1, L3).
func platformServiceStatus(name string) (running bool, supported bool) {
	return classifyServiceLookup(svcquery.GetStatus(name))
}
