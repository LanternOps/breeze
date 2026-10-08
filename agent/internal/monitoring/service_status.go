package monitoring

import (
	"errors"

	"github.com/breeze-rmm/agent/internal/svcquery"
)

// serviceErrorStatus maps a failed svcquery.GetStatus lookup to a check status.
// Only a lookup that proved the service does not exist is not_found; any other
// failure (access denied, SCM unavailable, query error) is an error — the
// service may well exist and be running (#7967).
func serviceErrorStatus(err error) CheckStatus {
	if errors.Is(err, svcquery.ErrServiceNotFound) {
		return StatusNotFound
	}
	return StatusError
}
