package pamlifetime

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

const reconciliationObservationIdentityPrefix = "https://breezermm.com/protocol/pam-reconciliation-observation/v1/"

// ReconciliationObservationID derives the stable per-boot identity used to
// make startup reconciliation retries idempotent across agent restarts.
func ReconciliationObservationID(result Result) (string, error) {
	actuationID, err := uuid.Parse(result.ActuationID)
	if err != nil {
		return "", fmt.Errorf("parse actuation ID: %w", err)
	}
	if result.Generation == 0 {
		return "", errors.New("generation must be positive")
	}
	if result.State == "" {
		return "", errors.New("state is required")
	}
	if result.Evidence.BootID == "" {
		return "", errors.New("boot ID is required")
	}

	identity, err := json.Marshal([]any{
		strings.ToLower(actuationID.String()),
		result.Generation,
		string(result.State),
		result.Evidence.BootID,
	})
	if err != nil {
		return "", fmt.Errorf("encode reconciliation identity: %w", err)
	}
	name := append([]byte(reconciliationObservationIdentityPrefix), identity...)
	return uuid.NewSHA1(uuid.NameSpaceURL, name).String(), nil
}
