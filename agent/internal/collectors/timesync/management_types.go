package timesync

import (
	"context"
	"time"
	"unicode/utf16"
)

type Settings struct {
	EnforceNTP          bool             `json:"enforce_ntp"`
	NTPServers          []string         `json:"ntp_servers"`
	PollIntervalMinutes int              `json:"poll_interval_minutes"`
	Timezone            TimezoneSettings `json:"timezone"`
	Fingerprint         string           `json:"fingerprint"`
}
type TimezoneSettings struct {
	ExpectedWindowsID *string `json:"expected_windows_id"`
	AutoFix           bool    `json:"auto_fix"`
}
type ManagementReport struct {
	NTP      *EnforcementResult `json:"ntp"`
	Timezone *EnforcementResult `json:"timezone"`
}
type AttemptGate struct {
	Fingerprint string    `json:"fingerprint"`
	Next        time.Time `json:"next"`
	Failures    int       `json:"failures"`
}
type ManagementState struct {
	Version      int              `json:"version"`
	Settings     *Settings        `json:"settings"`
	Report       ManagementReport `json:"report"`
	NTPGate      AttemptGate      `json:"ntpGate"`
	TimezoneGate AttemptGate      `json:"timezoneGate"`
}

// These tags are a projection of index B, not additional wire fields.
type Observation struct {
	Config struct {
		Type                       *string `json:"type"`
		NTPServer                  *string `json:"ntpServer"`
		SpecialPollIntervalSeconds *int    `json:"specialPollIntervalSeconds"`
		PolicyManaged              bool    `json:"policyManaged"`
		ServiceState               string  `json:"serviceState"`
		ServiceStartType           string  `json:"serviceStartType"`
	} `json:"config"`
	Domain struct {
		Role string `json:"role"`
	} `json:"domain"`
	Timezone struct {
		WindowsID  *string `json:"windowsId"`
		AutoUpdate string  `json:"autoUpdate"`
	} `json:"timezone"`
	Status struct {
		LastSuccessfulSyncAt *string `json:"lastSuccessfulSyncAt"`
	} `json:"status"`
}
type ReadObservation func(context.Context) (Observation, error)

func scalar[T any](p *T) any {
	if p == nil {
		return nil
	}
	return *p
}
func value[T comparable](p *T, want T) bool { return p != nil && *p == want }
func managementPtr[T any](v T) *T           { return &v }
func errorText(err error) *string {
	if err == nil {
		return nil
	}
	runes := make([]rune, 0, 512)
	units := 0
	for _, r := range err.Error() {
		n := utf16.RuneLen(r)
		if units+n > 512 {
			break
		}
		runes = append(runes, r)
		units += n
	}
	s := string(runes)
	return &s
}
