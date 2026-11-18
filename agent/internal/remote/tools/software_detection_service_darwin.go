//go:build darwin

package tools

import "github.com/breeze-rmm/agent/internal/svcquery"

// platformServiceStatus queries launchd by label (svcquery). Exercised only in
// the owner lab (gate L2).
func platformServiceStatus(name string) (running bool, supported bool) {
	return classifyServiceLookup(svcquery.GetStatus(name))
}
