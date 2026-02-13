package mgmtdetect

import "testing"

func TestDeriveJoinType(t *testing.T) {
	tests := []struct {
		azure, domain, workplace bool
		want                     string
	}{
		{true, true, false, "hybrid_azure_ad"},
		{true, false, false, "azure_ad"},
		{false, true, false, "on_prem_ad"},
		{false, false, true, "workplace"},
		{false, false, false, "none"},
	}
	for _, tt := range tests {
		id := IdentityStatus{
			AzureAdJoined:   tt.azure,
			DomainJoined:    tt.domain,
			WorkplaceJoined: tt.workplace,
		}
		got := deriveJoinType(id)
		if got != tt.want {
			t.Errorf("azure=%v domain=%v workplace=%v: got %s, want %s",
				tt.azure, tt.domain, tt.workplace, got, tt.want)
		}
	}
}

func TestParseDsregcmdOutput(t *testing.T) {
	sample := `
+----------------------------------------------------------------------+
| Device State                                                         |
+----------------------------------------------------------------------+

             AzureAdJoined : YES
          EnterpriseJoined : NO
              DomainJoined : YES
                DomainName : CONTOSO
           WorkplaceJoined : NO

+----------------------------------------------------------------------+
| Tenant Details                                                       |
+----------------------------------------------------------------------+

                  TenantId : 12345678-1234-1234-1234-123456789abc
                    MdmUrl : https://enrollment.manage.microsoft.com/enrollmentserver/discovery.svc
`
	id := parseDsregcmdOutput(sample)
	if !id.AzureAdJoined {
		t.Error("expected AzureAdJoined = true")
	}
	if !id.DomainJoined {
		t.Error("expected DomainJoined = true")
	}
	if id.WorkplaceJoined {
		t.Error("expected WorkplaceJoined = false")
	}
	if id.DomainName != "CONTOSO" {
		t.Errorf("expected CONTOSO, got %s", id.DomainName)
	}
	if id.TenantId != "12345678-1234-1234-1234-123456789abc" {
		t.Errorf("unexpected tenantId: %s", id.TenantId)
	}
	if id.MdmUrl != "https://enrollment.manage.microsoft.com/enrollmentserver/discovery.svc" {
		t.Errorf("unexpected MdmUrl: %s", id.MdmUrl)
	}
	if id.JoinType != "hybrid_azure_ad" {
		t.Errorf("expected hybrid_azure_ad, got %s", id.JoinType)
	}
}
