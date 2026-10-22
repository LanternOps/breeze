package patching

import "testing"

func TestWindowsSeverity(t *testing.T) {
	cases := []struct {
		name         string
		msrc         string
		categories   []string
		title        string
		wantSeverity string
		wantSource   string
	}{
		// MSRC rating present: it always wins and is labelled as the vendor's.
		{
			name:         "msrc rating wins over classification",
			msrc:         "Moderate",
			categories:   []string{"Critical Updates", "Windows 11"},
			title:        "2026-10 Security Update for Microsoft Office",
			wantSeverity: "moderate",
			wantSource:   SeveritySourceVendor,
		},
		{
			name:         "msrc rating is lowercased",
			msrc:         "Important",
			categories:   []string{"Security Updates", "Microsoft .NET Framework 4.8.1"},
			title:        "Security Update for .NET Framework",
			wantSeverity: "important",
			wantSource:   SeveritySourceVendor,
		},
		{
			name:         "unrecognised msrc value falls through to derivation",
			msrc:         "Unspecified",
			categories:   []string{"Security Updates"},
			title:        "Something",
			wantSeverity: "important",
			wantSource:   SeveritySourceDerived,
		},

		// No MSRC rating: derive from classification, then title.
		{
			// Capped at important: WUA's Critical Updates classification also
			// covers non-security fixes, and a derived critical would feed
			// rings that auto-approve critical only.
			name:         "critical updates classification is capped at important",
			categories:   []string{"Windows 11", "Critical Updates"},
			title:        "Update for Windows 11 (KB5000001)",
			wantSeverity: "important",
			wantSource:   SeveritySourceDerived,
		},
		{
			name:         "critical updates with a security title is still capped at important",
			categories:   []string{"Critical Updates", "Security Updates"},
			title:        "Critical Security Update for Windows",
			wantSeverity: "important",
			wantSource:   SeveritySourceDerived,
		},
		{
			name:         "security updates classification derives important",
			categories:   []string{"Windows 11", "Security Updates"},
			title:        "2026-10 Cumulative Update for Windows 11 Version 24H2 (KB5127001)",
			wantSeverity: "important",
			wantSource:   SeveritySourceDerived,
		},
		{
			name:         "cumulative update title under generic classification derives important",
			categories:   []string{"Updates", "Windows Server 2022"},
			title:        "2026-10 Cumulative Update for Microsoft server operating system (KB5127002)",
			wantSeverity: "important",
			wantSource:   SeveritySourceDerived,
		},
		{
			name:         "security update title under generic classification derives important",
			categories:   []string{"Updates"},
			title:        "Security Update for Microsoft Visual C++ Redistributable",
			wantSeverity: "important",
			wantSource:   SeveritySourceDerived,
		},
		{
			name:         "cumulative update preview stays unknown",
			categories:   []string{"Updates", "Windows 11"},
			title:        "2026-10 Cumulative Update Preview for Windows 11 Version 24H2 (KB5127003)",
			wantSeverity: "unknown",
			wantSource:   "",
		},
		{
			name:         "update rollup with security in title derives important",
			categories:   []string{"Update Rollups", "Windows Server 2016"},
			title:        "2026-10 Security Monthly Quality Rollup for Windows Server 2016 (KB5127004)",
			wantSeverity: "important",
			wantSource:   SeveritySourceDerived,
		},
		{
			name:         "update rollup without security stays unknown",
			categories:   []string{"Update Rollups", "Windows 11"},
			title:        "Windows Malicious Software Removal Tool x64 - v5.130 (KB890830)",
			wantSeverity: "unknown",
			wantSource:   "",
		},
		{
			name:         "update rollup titled cumulative but not security stays unknown",
			categories:   []string{"Update Rollups"},
			title:        "Cumulative Update for .NET Framework 3.5 and 4.8.1",
			wantSeverity: "unknown",
			wantSource:   "",
		},

		// Classifications that never carry a security rating stay unknown even
		// when the title says "Security".
		{
			name:         "defender security intelligence definition stays unknown",
			categories:   []string{"Definition Updates", "Microsoft Defender Antivirus"},
			title:        "Security Intelligence Update for Microsoft Defender Antivirus - KB2267602 (Version 1.421.0.0)",
			wantSeverity: "unknown",
			wantSource:   "",
		},
		{
			name:         "drivers stay unknown",
			categories:   []string{"Drivers", "Windows 11 Client, version 24H2 and later, Servicing Drivers"},
			title:        "Intel Corporation - Extension - 31.0.101.5590",
			wantSeverity: "unknown",
			wantSource:   "",
		},
		{
			name:         "feature packs stay unknown",
			categories:   []string{"Feature Packs"},
			title:        "Security Feature Pack",
			wantSeverity: "unknown",
			wantSource:   "",
		},
		{
			name:         "tools stay unknown",
			categories:   []string{"Tools"},
			title:        "Security Compliance Toolkit",
			wantSeverity: "unknown",
			wantSource:   "",
		},
		{
			name:         "upgrades (feature updates) stay unknown",
			categories:   []string{"Upgrades", "Windows 11"},
			title:        "Windows 11, version 26H2 (KB5127648)",
			wantSeverity: "unknown",
			wantSource:   "",
		},
		{
			name:         "product name containing security is not a classification",
			categories:   []string{"Microsoft Security Essentials", "Updates"},
			title:        "Update for Microsoft Security Essentials",
			wantSeverity: "unknown",
			wantSource:   "",
		},
		{
			name:         "nothing to go on stays unknown",
			categories:   nil,
			title:        "",
			wantSeverity: "unknown",
			wantSource:   "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gotSeverity, gotSource := windowsSeverity(c.msrc, c.categories, c.title)
			if gotSeverity != c.wantSeverity || gotSource != c.wantSource {
				t.Errorf("windowsSeverity(%q, %q, %q) = (%q, %q), want (%q, %q)",
					c.msrc, c.categories, c.title, gotSeverity, gotSource, c.wantSeverity, c.wantSource)
			}
		})
	}
}
