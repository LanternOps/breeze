package branding

import (
	"fmt"
	"os"
	"strings"
)

// OrValid is Or plus the build-time rules (see Valid): a value that is not
// valid falls back as if it were unset. build-edition.sh already refuses such
// a value, but a raw `go build -ldflags -X` skips it, and a service
// registration must not carry a value the build gates would have refused. A
// warning goes to stderr; the value is not echoed back.
func OrValid(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	if !Valid(value) {
		fmt.Fprintln(os.Stderr, "Warning: ignoring a branding value that is not valid; using the default text")
		return fallback
	}
	return value
}
