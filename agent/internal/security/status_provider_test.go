package security

import "testing"

func TestProviderFromName(t *testing.T) {
	cases := []struct {
		name     string
		display  string
		expected string
	}{
		{"microsoft defender", "Windows Defender", "windows_defender"},
		{"sentinelone", "SentinelOne", "sentinelone"},
		{"crowdstrike", "CrowdStrike Falcon", "crowdstrike"},
		{"elastic defend", "Elastic Defend", "elastic_defend"},
		{"elastic endpoint security", "Elastic Endpoint Security", "elastic_defend"},
		{"elastic agent", "Elastic Agent", "elastic_defend"},
		// Locks the elastic-before-defender ordering: an "Elastic Defender"-style
		// name must not fall through to the broad "defender" → windows_defender case.
		{"elastic defender", "Elastic Defender", "elastic_defend"},
		// Locks the bitdefender-before-defender ordering: "Bitdefender" contains
		// the substring "defender", so these must not fall through to the broad
		// "defender" → windows_defender case (#2075).
		{"bitdefender", "Bitdefender", "bitdefender"},
		{"bitdefender endpoint security", "Bitdefender Endpoint Security", "bitdefender"},
		// ESET (#7551). Match "eset" as a whole token so names that merely
		// contain the letters — "Preset", "Reset" — don't become ESET.
		{"eset security", "ESET Security", "eset"},
		{"eset endpoint antivirus", "ESET Endpoint Antivirus", "eset"},
		{"eset nod32", "ESET NOD32 Antivirus", "eset"},
		{"eset underscore", "eset_endpoint_security", "eset"},
		{"not eset: reset", "Acme Reset Guard", "other"},
		{"not eset: preset", "Preset Protection", "other"},
		{"not eset: resetter", "ResetterAV", "other"},
		{"not eset: letter after", "Esets Guard", "other"},
		{"eset only", "ESET", "eset"},
		{"eset trailing", "Acme ESET", "eset"},
		{"eset digit boundary", "eset2", "eset"},
		// The first occurrence is embedded in "Reset"; the second is the word.
		{"embedded then word", "Reset ESET Endpoint", "eset"},
		// Emsisoft, Webroot, WithSecure / F-Secure (#7551).
		{"emsisoft anti-malware", "Emsisoft Anti-Malware", "emsisoft"},
		{"emsisoft enterprise security", "Emsisoft Enterprise Security", "emsisoft"},
		{"webroot secureanywhere", "Webroot SecureAnywhere", "webroot"},
		{"withsecure elements", "WithSecure Elements Agent", "withsecure"},
		{"withsecure client security", "WithSecure Client Security", "withsecure"},
		{"f-secure", "F-Secure SAFE", "withsecure"},
		{"f-secure computer protection", "F-Secure Computer Protection", "withsecure"},
		// ThreatDown is Malwarebytes' business rebrand (#7551).
		{"threatdown", "ThreatDown Endpoint Protection", "malwarebytes"},
		{"threatdown upper", "THREATDOWN", "malwarebytes"},
		// Locks the vendor-before-defender ordering for the new cases.
		{"threatdown vs defender", "ThreatDown Defender Plus", "malwarebytes"},
		{"webroot vs defender", "Webroot Defender", "webroot"},
		// CylancePROTECT, rebranded Aurora Endpoint Defense (#9178). Windows
		// Security Center still registers it as "CylancePROTECT" after the rebrand.
		{"cylanceprotect", "CylancePROTECT", "cylance"},
		{"cylance lower", "cylanceprotect", "cylance"},
		{"cylance optics", "CylanceOPTICS", "cylance"},
		// Locks the cylance-before-defender ordering.
		{"cylance vs defender", "Cylance Defender Shield", "cylance"},
		// Trend Micro (#8171). These names follow vendor product naming; none was
		// captured from a Windows Security Center registration. Add observed
		// names as rows when a lab host reports them.
		{"trend apex one", "Trend Micro Apex One Security Agent", "trend_micro"},
		{"trend security agent", "Trend Micro Security Agent", "trend_micro"},
		{"trend officescan", "Trend Micro OfficeScan Client", "trend_micro"},
		{"trend worry-free", "Trend Micro Worry-Free Business Security Agent", "trend_micro"},
		{"trend no space", "TrendMicro Endpoint Sensor", "trend_micro"},
		// Synthetic name: locks the trend-before-defender ordering.
		{"trend vs defender", "Trend Micro Defender Suite", "trend_micro"},
		// "trend" alone is not the vendor: the match needs "trend micro" or
		// "trendmicro".
		{"not trend: market trends", "Market Trends Agent", "other"},
		{"not trend: trendy", "Trendy Shield", "other"},
		// Huntress is deliberately not a provider (#8171; EDR framework index,
		// "Needs Todd's decision" item 1). Huntress Managed AV works through
		// Microsoft Defender, which already reports as windows_defender, so a
		// "huntress" provider would relabel those devices. mgmtdetect still lists
		// Huntress as a management tool.
		{"huntress is not a WSC provider", "Huntress Managed AV", "other"},
		{"malwarebytes", "Malwarebytes", "malwarebytes"},
		// Regression guards for the broad matches the new cases sit beside.
		{"microsoft defender antivirus", "Microsoft Defender Antivirus", "windows_defender"},
		{"sophos", "Sophos Intercept X", "sophos"},
		{"kaspersky", "Kaspersky Endpoint Security for Windows", "kaspersky"},
		{"unknown product", "Acme Shield", "other"},
		{"empty", "", "other"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := providerFromName(tc.display); got != tc.expected {
				t.Fatalf("providerFromName(%q) = %q, want %q", tc.display, got, tc.expected)
			}
		})
	}
}
