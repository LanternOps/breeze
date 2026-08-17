package security

import "testing"

func TestResolveWSCPrimary(t *testing.T) {
	defender := AVProduct{
		DisplayName:        "Windows Defender",
		Provider:           "windows_defender",
		Registered:         true,
		RealTimeProtection: false,
	}
	cylance := AVProduct{
		DisplayName:        "CylancePROTECT",
		Provider:           "other",
		Registered:         true,
		RealTimeProtection: true,
	}
	sophos := AVProduct{
		DisplayName:        "Sophos Intercept X",
		Provider:           "sophos",
		Registered:         true,
		RealTimeProtection: true,
	}
	unnamed := AVProduct{Provider: "other", Registered: false}

	cases := []struct {
		name           string
		products       []AVProduct
		wantProvider   string
		wantRealTime   bool
		wantIdentified bool
	}{
		{"no products", nil, "", false, false},
		{"single disabled defender", []AVProduct{defender}, "windows_defender", false, true},
		{
			// #3593: Defender is listed first but disabled; the active third-party
			// product wins the provider label even though its name maps to "other".
			name:           "third-party with rtp beats disabled defender",
			products:       []AVProduct{defender, cylance},
			wantProvider:   "other",
			wantRealTime:   true,
			wantIdentified: true,
		},
		{
			name:           "first product reporting rtp wins",
			products:       []AVProduct{defender, sophos, cylance},
			wantProvider:   "sophos",
			wantRealTime:   true,
			wantIdentified: true,
		},
		{
			// Nothing reports real-time protection: fall back to the first product.
			name:           "falls back to first product",
			products:       []AVProduct{defender, {DisplayName: "Acme Shield", Provider: "other", Registered: true}},
			wantProvider:   "windows_defender",
			wantRealTime:   false,
			wantIdentified: true,
		},
		{
			// An unregistered (nameless) entry is not a real attribution, so the
			// Defender fallback is still allowed to claim the provider label.
			name:           "unregistered product does not identify a provider",
			products:       []AVProduct{unnamed},
			wantProvider:   "other",
			wantRealTime:   false,
			wantIdentified: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			primary, identified := resolveWSCPrimary(tc.products)
			if primary.Provider != tc.wantProvider {
				t.Errorf("provider = %q, want %q", primary.Provider, tc.wantProvider)
			}
			if primary.RealTimeProtection != tc.wantRealTime {
				t.Errorf("realTimeProtection = %v, want %v", primary.RealTimeProtection, tc.wantRealTime)
			}
			if identified != tc.wantIdentified {
				t.Errorf("identified = %v, want %v", identified, tc.wantIdentified)
			}
		})
	}
}

func TestDefenderOwnsProvider(t *testing.T) {
	cases := []struct {
		name               string
		providerIdentified bool
		currentRealTime    bool
		defenderRealTime   bool
		want               bool
	}{
		{
			// Windows Server / no Security Center data: Defender is all we have.
			name: "no provider identified", providerIdentified: false,
			currentRealTime: false, defenderRealTime: false, want: true,
		},
		{
			name: "no provider identified and defender active", providerIdentified: false,
			currentRealTime: false, defenderRealTime: true, want: true,
		},
		{
			// The #3593 regression: a registered third-party product (provider
			// "other") supplied realTimeProtection=true and Defender is disabled.
			// Defender must NOT relabel that row as windows_defender.
			name: "third-party owns an active row", providerIdentified: true,
			currentRealTime: true, defenderRealTime: false, want: false,
		},
		{
			// Same shape, but neither is protecting: still not Defender's row.
			name: "third-party owns an inactive row", providerIdentified: true,
			currentRealTime: false, defenderRealTime: false, want: false,
		},
		{
			// Defender is the only source reporting active protection, so it is
			// what is actually protecting the device and owns the label.
			name: "defender is the only active source", providerIdentified: true,
			currentRealTime: false, defenderRealTime: true, want: true,
		},
		{
			// Both active: the already-identified product keeps the label.
			name: "both active", providerIdentified: true,
			currentRealTime: true, defenderRealTime: true, want: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := defenderOwnsProvider(tc.providerIdentified, tc.currentRealTime, tc.defenderRealTime)
			if got != tc.want {
				t.Fatalf("defenderOwnsProvider(%v, %v, %v) = %v, want %v",
					tc.providerIdentified, tc.currentRealTime, tc.defenderRealTime, got, tc.want)
			}
		})
	}
}
