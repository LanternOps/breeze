package agentapp

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"
)

// enrollFlagError rewrites cobra's bare "unknown flag: --site-id" into an
// actionable message. The flag was ignored since #8474 (the server derives the
// site from the enrollment key) and removed in #8493; scripts that still pass
// it need to be told what to do rather than just that the flag is unknown.
func enrollFlagError(_ *cobra.Command, err error) error {
	// Exact match: pflag reports "--site-id=x" as "unknown flag: --site-id",
	// while a different flag like --site-identifier must not be rewritten.
	if err != nil && strings.TrimSpace(err.Error()) == "unknown flag: --site-id" {
		return fmt.Errorf("--site-id was removed: the site now comes from the enrollment key, so drop the flag from your script")
	}
	return err
}
