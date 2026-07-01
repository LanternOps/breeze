package patching

import (
	"strings"
	"testing"
	"time"
)

func TestSystemScanArgsMachineScopeWingetSource(t *testing.T) {
	j := strings.Join(systemScanArgs(), " ")
	for _, want := range []string{"upgrade", "--scope", "machine", "--source", "winget", "--disable-interactivity"} {
		if !strings.Contains(j, want) {
			t.Fatalf("scan args missing %q: %s", want, j)
		}
	}
	if strings.Contains(j, "msstore") {
		t.Fatal("scan must not use msstore source")
	}
}

func TestSystemInstallRejectsBadID(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
		t.Fatal("must not exec on invalid id")
		return "", "", 0, nil
	})
	if _, err := p.Install("Bad ID; rm -rf"); err == nil {
		t.Fatal("want validation error")
	}
}

func TestSystemScanParsesUpgrades(t *testing.T) {
	out := "Name    Id               Version  Available Source\n" +
		"-----------------------------------------------------\n" +
		"Firefox Mozilla.Firefox   1.0      2.0       winget\n"
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(name string, args []string, _ time.Duration) (string, string, int, error) {
		return out, "", 0, nil
	})
	patches, err := p.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(patches) != 1 || patches[0].ID != "Mozilla.Firefox" {
		t.Fatalf("got %+v", patches)
	}
}

func TestSystemInstallSuccess(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(name string, args []string, _ time.Duration) (string, string, int, error) {
		if !strings.Contains(strings.Join(args, " "), "--scope machine") {
			t.Fatalf("install missing machine scope: %v", args)
		}
		return "Successfully installed", "", 0, nil
	})
	res, err := p.Install("Mozilla.Firefox")
	if err != nil {
		t.Fatal(err)
	}
	if res.PatchID != "Mozilla.Firefox" {
		t.Fatalf("got %+v", res)
	}
}
