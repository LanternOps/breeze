package timesync

import (
	"context"
	"testing"

	"github.com/breeze-rmm/agent/internal/mgmtdetect"
)

func TestDomainRoles(t *testing.T) {
	for _, tc := range []struct {
		join                             string
		machine                          uint32
		domain, forest, pdc, local, want string
	}{
		{"none", 0, "", "", "", "", "workgroup"},
		{"workplace", 0, "", "", "", "", "workgroup"},
		{"azure_ad", 0, "", "", "", "", "entra_only"},
		{"on_prem_ad", 1, "ad.example.com", "ad.example.com", "pdc.ad.example.com", "member.ad.example.com", "member"},
		{"hybrid_azure_ad", 3, "ad.example.com", "ad.example.com", "pdc.ad.example.com", "member.ad.example.com", "member"},
		{"on_prem_ad", 4, "ad.example.com", "ad.example.com", "pdc.ad.example.com", "dc.ad.example.com", "dc"},
		{"on_prem_ad", 5, "child.example.com", "example.com", "pdc.child.example.com", "PDC.CHILD.EXAMPLE.COM.", "pdc_emulator"},
		{"on_prem_ad", 5, "EXAMPLE.COM", "example.com", `\\pdc.example.com`, "pdc.example.com", "forest_root_pdc_emulator"},
		{"unknown", 0, "", "", "", "", "unknown"},
		{"on_prem_ad", 0, "ad.example.com", "ad.example.com", "pdc.ad.example.com", "pdc.ad.example.com", "unknown"},
	} {
		t.Run(tc.join+"/"+tc.want, func(t *testing.T) {
			f := &fakeSystem{identity: mgmtdetect.IdentityStatus{JoinType: mgmtdetect.JoinType(tc.join), Source: "dsregcmd"},
				role: RoleInfo{tc.machine, tc.domain, tc.forest}, pdc: tc.pdc, computer: tc.local}
			got := readDomain(context.Background(), f)
			if got.Role != tc.want {
				t.Fatalf("got %+v, want %s", got, tc.want)
			}
			if tc.pdc != "" && got.PDCName == nil {
				t.Fatal("resolved PDC omitted")
			}
		})
	}
}

func TestDomainFailuresAreUnknown(t *testing.T) {
	for _, fail := range []string{"identity", "role", "pdc", "computer", "missing_forest", "short_name", "identity_fallback"} {
		t.Run(fail, func(t *testing.T) {
			f := &fakeSystem{identity: mgmtdetect.IdentityStatus{JoinType: mgmtdetect.JoinTypeOnPremAD, Source: "dsregcmd"},
				role: RoleInfo{5, "ad.example.com", "ad.example.com"}, pdc: "pdc.ad.example.com", computer: "pdc.ad.example.com"}
			switch fail {
			case "identity":
				f.identity.Source = ""
			case "role":
				f.roleErr = errUnavailable
			case "pdc":
				f.pdcErr = errUnavailable
			case "computer":
				f.computerErr = errUnavailable
			case "missing_forest":
				f.role.ForestDNS = ""
			case "short_name":
				f.computer = "pdc"
			case "identity_fallback":
				f.identity.JoinType = mgmtdetect.JoinTypeNone
				f.identity.Source = "dsregcmd_error_no_fallback"
			}
			if got := readDomain(context.Background(), f); got.Role != "unknown" {
				t.Fatalf("%s: %+v", fail, got)
			}
		})
	}
}
