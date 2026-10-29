package collectors

import (
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestApplicationProviderNames(t *testing.T) {
	for _, name := range []string{"MSSQL$SQLEXPRESS", "Dell UPS Local Node Manager", "APCPBEAgent", "Microsoft-Windows-Foo", "A ._$()-", strings.Repeat("A", 256)} {
		if !validApplicationProviderName(name) {
			t.Errorf("valid provider rejected: %q", name)
		}
	}
	for _, name := range []string{"", ".NET Runtime", "Foo' or '1'='1", `Foo"]`, "A[B]", "x<y", "a&b", "a`b", "a;b", "a/b", `a\b`, strings.Repeat("A", 257)} {
		if validApplicationProviderName(name) {
			t.Errorf("unsafe provider accepted: %q", name)
		}
	}
}

func TestUpdateApplicationProviders(t *testing.T) {
	c := NewEventLogCollector()
	changed, rejected := c.UpdateApplicationProviders([]string{" Dell UPS Local Node Manager ", "dell ups local node manager", "bad'name", "MSSQL$SQLEXPRESS"})
	want := []string{"Dell UPS Local Node Manager", "MSSQL$SQLEXPRESS"}
	if !changed || !reflect.DeepEqual(rejected, []string{"bad'name"}) || !reflect.DeepEqual(c.ApplicationProviders(), want) {
		t.Fatalf("changed=%v rejected=%v providers=%v", changed, rejected, c.ApplicationProviders())
	}
	if changed, _ := c.UpdateApplicationProviders(want); changed {
		t.Fatal("unchanged list reported changed")
	}
	copyOf := c.ApplicationProviders()
	copyOf[0] = "mutated"
	if c.ApplicationProviders()[0] != want[0] {
		t.Fatal("getter aliases stored list")
	}
	many := []string{"First", "first"}
	for i := 0; i < 21; i++ {
		many = append(many, fmt.Sprintf("Provider%d", i))
	}
	c.UpdateApplicationProviders(many)
	if len(c.ApplicationProviders()) != 20 {
		t.Fatalf("cap not applied: %v", c.ApplicationProviders())
	}
	c.UpdateApplicationProviders(nil)
	if len(c.ApplicationProviders()) != 0 {
		t.Fatal("empty list must clear")
	}
}

func TestEffectiveApplicationProviders(t *testing.T) {
	got := effectiveApplicationProviders([]string{"msiinstaller", "APCPBEAGENT", "UPS", "ups", "bad'name"})
	if !reflect.DeepEqual(got, []string{"MsiInstaller", "APCPBEAgent", "UPS"}) {
		t.Fatalf("effective providers=%v", got)
	}
	many := make([]string, 25)
	for i := range many {
		many[i] = fmt.Sprintf("Provider%d", i)
	}
	if got := effectiveApplicationProviders(many); len(got) != 22 {
		t.Fatalf("policy cap: %v", got)
	}
}

func TestApplicationProviderInjectionPipeline(t *testing.T) {
	bad := []string{"bad'name", `bad"name`, "bad[name", "bad]name", "bad<name", "bad&name", "bad`name", "bad;name"}
	c := NewEventLogCollector()
	c.UpdateApplicationProviders(append(bad, "MSSQL$SQLEXPRESS"))
	for _, stream := range windowsEventStreams([]string{"application"}, effectiveApplicationProviders(c.ApplicationProviders())) {
		if stream.key != "application-providers" {
			continue
		}
		now := time.Now()
		xpath, _ := buildWinEventXPath(stream.selection, nil, now, now)
		command := buildWinEventCommand(stream.logName, xpath)
		for _, unsafe := range bad {
			if strings.Contains(xpath, unsafe) || strings.Contains(command, unsafe) {
				t.Errorf("unsafe name leaked: %q", unsafe)
			}
		}
		if !strings.Contains(xpath, "@Name='MSSQL$SQLEXPRESS'") {
			t.Fatalf("valid literal missing: %s", xpath)
		}
		if !strings.Contains(command, "-FilterXPath "+psSingleQuote(xpath)+" -Oldest") {
			t.Fatalf("XPath not one quoted literal: %s", command)
		}
	}
}

func TestApplicationProviderConcurrentUpdates(t *testing.T) {
	c := NewEventLogCollector()
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.UpdateApplicationProviders([]string{"UPS"})
			c.ApplicationProviders()
			c.snapshotWindowsStreams(time.Now())
		}()
	}
	wg.Wait()
}
