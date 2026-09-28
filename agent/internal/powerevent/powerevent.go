// Package powerevent classifies Windows power-broadcast event types (the
// dwEventType of a SERVICE_CONTROL_POWEREVENT control, i.e. the PBT_* values
// of WM_POWERBROADCAST). golang.org/x/sys/windows does not export the PBT_*
// constants. The package is platform-independent so the classification is
// unit-testable on every OS; only the Windows service handlers feed it.
package powerevent

import "fmt"

// PBT_* values from winuser.h.
const (
	pbtAPMSuspend           uint32 = 0x0004
	pbtAPMResumeCritical    uint32 = 0x0006
	pbtAPMResumeSuspend     uint32 = 0x0007
	pbtAPMPowerStatusChange uint32 = 0x000A
	pbtAPMResumeAutomatic   uint32 = 0x0012
	pbtPowerSettingChange   uint32 = 0x8013
)

// Kind is the coarse meaning of a power event.
type Kind int

const (
	// Other is any event that is neither a suspend nor a resume (power
	// source changes, battery status, power-setting changes, unknown values).
	Other Kind = iota
	// Suspend: the system is about to sleep (PBT_APMSUSPEND).
	Suspend
	// Resume: the system has resumed from sleep. PBT_APMRESUMEAUTOMATIC is
	// sent on every resume, including unattended/maintenance wakes;
	// PBT_APMRESUMESUSPEND follows it only when a user is present;
	// PBT_APMRESUMECRITICAL is the pre-Vista critical-resume variant.
	Resume
)

func (k Kind) String() string {
	switch k {
	case Suspend:
		return "suspend"
	case Resume:
		return "resume"
	default:
		return "other"
	}
}

// Classify maps a PBT_* event type to its Kind.
func Classify(eventType uint32) Kind {
	switch eventType {
	case pbtAPMSuspend:
		return Suspend
	case pbtAPMResumeAutomatic, pbtAPMResumeSuspend, pbtAPMResumeCritical:
		return Resume
	default:
		return Other
	}
}

// Name returns the winuser.h name of a PBT_* event type, for logs.
func Name(eventType uint32) string {
	switch eventType {
	case pbtAPMSuspend:
		return "PBT_APMSUSPEND"
	case pbtAPMResumeCritical:
		return "PBT_APMRESUMECRITICAL"
	case pbtAPMResumeSuspend:
		return "PBT_APMRESUMESUSPEND"
	case pbtAPMPowerStatusChange:
		return "PBT_APMPOWERSTATUSCHANGE"
	case pbtAPMResumeAutomatic:
		return "PBT_APMRESUMEAUTOMATIC"
	case pbtPowerSettingChange:
		return "PBT_POWERSETTINGCHANGE"
	default:
		return fmt.Sprintf("PBT_%#x", eventType)
	}
}
