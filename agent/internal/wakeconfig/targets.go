package wakeconfig

// firmwareTarget is one firmware setting Wake-on-LAN needs, by exact vendor
// name. A device is firmware-ready only when every target for its vendor is
// present, its target value is in the model's allowed list, and the current
// value equals it. The list is compile-time: the server never names a setting.
// It is also the only source of the names and values a firmware write passes
// to Adapter.Apply (planFirmwareOps, TestOnlyTargetListNamesReachApply).
type firmwareTarget struct {
	Name  string
	Value string
	// Reason is the reason code when the current value is not Value.
	Reason string
}

// firmwareTargets by biosconfig adapter vendor. Dell names and values were
// confirmed against a lab OptiPlex 7060 (BIOS 1.17.0) through native BIOS WMI
// and cross-checked with Dell Command | Configure 5.2.1.16:
//
//	WakeOnLan     = Disabled   allowed Disabled,LanOnly,WlanOnly,LanWlan,LanWithPxeBoot
//	DeepSleepCtrl = S4AndS5    allowed Disabled,S5Only,S4AndS5
//
// DeepSleepCtrl S5Only or S4AndS5 powers the NIC down in S4/S5, so no wake from
// hibernate or shutdown. LanWlan and LanWithPxeBoot also enable wired wake but
// are not the target, so they read as not_configured (PXE boots the network
// rather than Windows).
var firmwareTargets = map[string][]firmwareTarget{
	"dell": {
		{Name: "WakeOnLan", Value: "LanOnly", Reason: "firmware_wake_on_lan_not_lan_only"},
		{Name: "DeepSleepCtrl", Value: "Disabled", Reason: "firmware_deep_sleep_enabled"},
	},
}
