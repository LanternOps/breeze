package peripheral

import (
	"fmt"
	"strings"
	"time"
)

// EvaluationResult pairs a detected peripheral with the policy verdict.
type EvaluationResult struct {
	Peripheral DetectedPeripheral
	Policy     *Policy // nil if no policy matched
	Action     string  // allow, block, read_only, alert, or "" if no policy
	Excepted   bool    // true if an exception rule overrode the policy
}

// Evaluate checks each detected peripheral against the active policies and
// returns a result per device. Policies are evaluated in order; the first
// matching policy wins.
func Evaluate(peripherals []DetectedPeripheral, policies []Policy) []EvaluationResult {
	results := make([]EvaluationResult, 0, len(peripherals))
	for _, p := range peripherals {
		result := evaluateOne(p, policies)
		results = append(results, result)
	}
	return results
}

func evaluateOne(dev DetectedPeripheral, policies []Policy) EvaluationResult {
	for i := range policies {
		pol := &policies[i]
		if !pol.IsActive {
			continue
		}
		if !classMatches(pol.DeviceClass, dev.DeviceClass) {
			continue
		}

		// Check exceptions
		if excepted, _ := matchesException(dev, pol.Exceptions); excepted {
			return EvaluationResult{
				Peripheral: dev,
				Policy:     pol,
				Action:     "allow",
				Excepted:   true,
			}
		}

		return EvaluationResult{
			Peripheral: dev,
			Policy:     pol,
			Action:     pol.Action,
			Excepted:   false,
		}
	}

	// No policy matched — implicitly allowed
	return EvaluationResult{Peripheral: dev}
}

// classMatches returns true if the policy class covers the device class.
func classMatches(policyClass, deviceClass string) bool {
	if policyClass == deviceClass {
		return true
	}
	// "all_usb" covers storage and generic USB devices
	if policyClass == "all_usb" && (deviceClass == "storage" || deviceClass == "all_usb") {
		return true
	}
	return false
}

// matchesException checks whether any non-expired exception rule matches the device.
func matchesException(dev DetectedPeripheral, exceptions []ExceptionRule) (bool, *ExceptionRule) {
	now := time.Now()
	for i := range exceptions {
		ex := &exceptions[i]
		if ex.ExpiresAt != "" {
			exp, err := time.Parse(time.RFC3339, ex.ExpiresAt)
			if err == nil && now.After(exp) {
				continue // expired
			}
		}
		if !fieldMatches(ex.Vendor, dev.Vendor) {
			continue
		}
		if !fieldMatches(ex.Product, dev.Product) {
			continue
		}
		if !fieldMatches(ex.SerialNumber, dev.SerialNumber) {
			continue
		}
		// At least one field must be specified for a valid exception
		if ex.Vendor == "" && ex.Product == "" && ex.SerialNumber == "" {
			continue
		}
		if ex.Allow {
			return true, ex
		}
	}
	return false, nil
}

// fieldMatches returns true if the rule field is empty (wildcard) or
// case-insensitively matches the device value.
func fieldMatches(ruleVal, deviceVal string) bool {
	if ruleVal == "" {
		return true
	}
	return strings.EqualFold(ruleVal, deviceVal)
}

// ToEvents converts evaluation results into PeripheralEvents ready for submission.
func ToEvents(results []EvaluationResult) []PeripheralEvent {
	events := make([]PeripheralEvent, 0, len(results))
	now := time.Now()
	for i, r := range results {
		eventType := "connected"
		details := map[string]any{}

		if r.Policy != nil {
			details["policyName"] = r.Policy.Name
			details["policyAction"] = r.Policy.Action
			details["excepted"] = r.Excepted

			switch r.Action {
			case "block":
				details["enforcement"] = "alert_only"
				details["note"] = "blocking requires kernel driver — logged for visibility"
			case "read_only":
				details["enforcement"] = "alert_only"
				details["note"] = "read-only mount requires kernel driver — logged for visibility"
			}
		}

		events = append(events, PeripheralEvent{
			EventID:        fmt.Sprintf("scan-%d-%d", now.Unix(), i),
			PolicyID:       policyID(r.Policy),
			EventType:      eventType,
			PeripheralType: r.Peripheral.PeripheralType,
			Vendor:         r.Peripheral.Vendor,
			Product:        r.Peripheral.Product,
			SerialNumber:   r.Peripheral.SerialNumber,
			Details:        details,
			OccurredAt:     now,
		})
	}
	return events
}

func policyID(p *Policy) string {
	if p == nil {
		return ""
	}
	return p.ID
}
