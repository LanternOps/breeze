package tccdiag

import (
	"fmt"
	"strings"
)

// The platform layer's decisions, kept free of cgo so they are tested on
// every OS.

// Security.framework values the platform layer interprets.
const (
	errSecCSUnsigned  = -67062 // the code has no signature
	errSecCSReqFailed = -67050 // the code does not satisfy the requirement
	kSecCodeSigAdhoc  = 0x0002 // kSecCodeSignatureAdhoc in kSecCodeInfoFlags
)

// signingFacts are the raw Security.framework results classifySigning reads.
type signingFacts struct {
	infoOK        bool  // SecCodeCopySigningInformation succeeded
	drUnsigned    bool  // SecCodeCopyDesignatedRequirement said errSecCSUnsigned
	hasIdentifier bool  // the signing information carried an identifier
	hasFlags      bool  // the signing information carried flags
	adhoc         bool  // the flags carry kSecCodeSignatureAdhoc
	devIDStatus   int32 // SecCodeCheckValidity against the Developer ID requirement
}

func classifySigning(f signingFacts) SigningKind {
	switch {
	case f.drUnsigned:
		return SigningUnsigned
	case !f.infoOK:
		return SigningUnknown
	case !f.hasIdentifier:
		return SigningUnsigned
	case f.adhoc:
		return SigningAdhoc
	case f.devIDStatus == 0:
		return SigningDeveloperID
	case f.devIDStatus == errSecCSReqFailed:
		return SigningOther
	default:
		return SigningUnknown
	}
}

// interpretRequirementStatus reads breeze_check_csreq's result. Stage 1 is
// decoding the stored blob; stage 2 is checking the running code against it.
// A failed requirement and an unsigned binary both mean "not satisfied"; any
// other failure means the requirement could not be evaluated.
func interpretRequirementStatus(status int32, stage int) (bool, error) {
	if stage == 1 {
		return false, fmt.Errorf("SecRequirementCreateWithData: OSStatus %d", status)
	}
	switch status {
	case 0:
		return true, nil
	case errSecCSReqFailed, errSecCSUnsigned:
		return false, nil
	default:
		return false, fmt.Errorf("SecCodeCheckValidity: OSStatus %d", status)
	}
}

// buildRowQuery selects the access rows for the bound clients and services.
// Every value is a bound parameter.
func buildRowQuery(clients, services int) string {
	return "SELECT service, client, auth_value, auth_reason, csreq, last_modified FROM access" +
		" WHERE client IN (" + placeholders(clients) + ")" +
		" AND service IN (" + placeholders(services) + ")"
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}
