package mgmtdetect

import "testing"

func TestDeriveJoinType(t *testing.T) {
	tests := []struct {
		azure, domain, workplace bool
		want                     JoinType
	}{
		{true, true, false, JoinTypeHybridAzureAD},
		{true, false, false, JoinTypeAzureAD},
		{false, true, false, JoinTypeOnPremAD},
		{false, false, true, JoinTypeWorkplace},
		{false, false, false, JoinTypeNone},
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
	if id.JoinType != JoinTypeHybridAzureAD {
		t.Errorf("expected hybrid_azure_ad, got %s", id.JoinType)
	}
}

func TestParseDsregcmdEmptyInput(t *testing.T) {
	id := parseDsregcmdOutput("")
	if id.Source != "dsregcmd" {
		t.Errorf("expected source dsregcmd, got %s", id.Source)
	}
	if id.JoinType != JoinTypeNone {
		t.Errorf("expected none join type for empty input, got %s", id.JoinType)
	}
	if id.AzureAdJoined || id.DomainJoined || id.WorkplaceJoined {
		t.Error("expected all join flags false for empty input")
	}
}

func TestParseDsregcmdAzureAdOnly(t *testing.T) {
	sample := `             AzureAdJoined : YES
              DomainJoined : NO
           WorkplaceJoined : NO
`
	id := parseDsregcmdOutput(sample)
	if !id.AzureAdJoined {
		t.Error("expected AzureAdJoined = true")
	}
	if id.DomainJoined {
		t.Error("expected DomainJoined = false")
	}
	if id.JoinType != JoinTypeAzureAD {
		t.Errorf("expected azure_ad, got %s", id.JoinType)
	}
}

func TestParseDsregcmdMalformedLines(t *testing.T) {
	// Lines with ":" but not " : " should be ignored by the parser
	sample := `Some:random:text
Garbage line with colon:value
             AzureAdJoined : YES
NoSpace:AtAll
`
	id := parseDsregcmdOutput(sample)
	if !id.AzureAdJoined {
		t.Error("expected AzureAdJoined = true despite malformed lines")
	}
	if id.JoinType != JoinTypeAzureAD {
		t.Errorf("expected azure_ad, got %s", id.JoinType)
	}
}
