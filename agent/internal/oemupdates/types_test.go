package oemupdates

import (
	"strings"
	"testing"
	"time"
)

const validPayload = `{
  "lane": "dell",
  "trigger": "on_demand",
  "occurrenceKey": null,
  "categories": ["driver", "bios"],
  "blockedUpdateIds": ["ABC12"],
  "rebootControlled": true,
  "notAfter": "2026-11-18T05:00:00Z",
  "escrowedProtectorIds": ["4f1c2a9e-1b2c-4d5e-8f90-0123456789ab"],
  "tool": {
    "version": "5.7.2",
    "minSafeVersion": "5.7.1",
    "supportedRange": { "min": "5.7.1", "maxExclusive": "6.0.0" },
    "url": "https://dl.dell.com/x/dcu.exe",
    "sha256": "` + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" + `",
    "prerequisites": [
      { "name": "dotnet_desktop_runtime", "minVersion": "10.0.8", "url": "https://builds.dotnet.microsoft.com/r.exe",
        "sha256": "` + "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210" + `" }
    ]
  }
}`

func TestParseRunRequestAcceptsTheContract(t *testing.T) {
	req, err := ParseRunRequest([]byte(validPayload))
	if err != nil {
		t.Fatalf("valid payload refused: %v", err)
	}
	if req.Lane != LaneDell || !req.RebootControlled || req.Tool == nil || len(req.Tool.Prerequisites) != 1 {
		t.Fatalf("parsed = %+v", req)
	}
	if !req.NotAfter.Equal(time.Date(2026, 11, 18, 5, 0, 0, 0, time.UTC)) {
		t.Fatalf("notAfter = %v", req.NotAfter)
	}
}

func TestParseRunRequestStrict(t *testing.T) {
	cases := map[string]string{
		"unknown top-level key":    strings.Replace(validPayload, `"lane": "dell",`, `"lane": "dell", "extra": 1,`, 1),
		"unknown nested key":       strings.Replace(validPayload, `"version": "5.7.2",`, `"version": "5.7.2", "args": "/evil",`, 1),
		"unknown lane":             strings.Replace(validPayload, `"lane": "dell"`, `"lane": "acme"`, 1),
		"unknown category":         strings.Replace(validPayload, `["driver", "bios"]`, `["driver", "bootloader"]`, 1),
		"duplicate category":       strings.Replace(validPayload, `["driver", "bios"]`, `["driver", "driver"]`, 1),
		"no categories":            strings.Replace(validPayload, `["driver", "bios"]`, `[]`, 1),
		"bad trigger":              strings.Replace(validPayload, `"on_demand"`, `"manual"`, 1),
		"http url":                 strings.Replace(validPayload, `https://dl.dell.com`, `http://dl.dell.com`, 1),
		"uppercase sha":            strings.Replace(validPayload, `0123456789abcdef0123`, `0123456789ABCDEF0123`, 1),
		"short sha":                strings.Replace(validPayload, `"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"`, `"abc"`, 1),
		"non-uuid protector":       strings.Replace(validPayload, `4f1c2a9e-1b2c-4d5e-8f90-0123456789ab`, `not-a-uuid`, 1),
		"missing notAfter":         strings.Replace(validPayload, `"notAfter": "2026-11-18T05:00:00Z",`, ``, 1),
		"bad notAfter":             strings.Replace(validPayload, `2026-11-18T05:00:00Z`, `tomorrow`, 1),
		"trailing data":            validPayload + `{}`,
		"empty blocked id":         strings.Replace(validPayload, `["ABC12"]`, `[""]`, 1),
		"control char in version":  strings.Replace(validPayload, `"version": "5.7.2"`, `"version": "5.7\u001b2"`, 1),
		"missing rebootControlled": strings.Replace(validPayload, `"rebootControlled": true,`, ``, 1),
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseRunRequest([]byte(payload)); err == nil {
				t.Fatalf("accepted: %s", name)
			}
		})
	}
}

func TestParseRunRequestBounds(t *testing.T) {
	ids := make([]string, 201)
	for i := range ids {
		ids[i] = `"X"`
	}
	payload := strings.Replace(validPayload, `["ABC12"]`, "["+strings.Join(ids, ",")+"]", 1)
	if _, err := ParseRunRequest([]byte(payload)); err == nil {
		t.Fatal("201 blocked ids accepted")
	}
	long := strings.Replace(validPayload, `["ABC12"]`, `["`+strings.Repeat("a", 129)+`"]`, 1)
	if _, err := ParseRunRequest([]byte(long)); err == nil {
		t.Fatal("a 129-character blocked id accepted")
	}
}

func TestResultValidateRejectsWhatZodRejects(t *testing.T) {
	ok := RunResult{Lane: LaneDell, Outcome: OutcomeSuccess, Takeover: TakeoverNotAttempted}
	if err := ok.Validate(); err != nil {
		t.Fatalf("minimal result: %v", err)
	}
	bad := map[string]func(r *RunResult){
		"unknown outcome": func(r *RunResult) { r.Outcome = "fine" },
		"unknown lane":    func(r *RunResult) { r.Lane = "acme" },
		"201 items": func(r *RunResult) {
			r.Items = make([]Item, 201)
			for i := range r.Items {
				r.Items[i] = Item{Title: "t", Category: CategoryDriver, Version: "1", Result: ItemInstalled}
			}
		},
		"long title": func(r *RunResult) {
			r.Items = []Item{{Title: strings.Repeat("a", 201), Category: CategoryDriver, Result: ItemInstalled}}
		},
		"control char title": func(r *RunResult) {
			r.Items = []Item{{Title: "a\nb", Category: CategoryDriver, Result: ItemInstalled}}
		},
		"bad errorCode": func(r *RunResult) { s := "has space"; r.ErrorCode = &s },
		"bad takeover":  func(r *RunResult) { r.Takeover = "maybe" },
	}
	for name, mutate := range bad {
		t.Run(name, func(t *testing.T) {
			r := ok
			mutate(&r)
			if err := r.Validate(); err == nil {
				t.Fatalf("Validate accepted %s", name)
			}
		})
	}
}

func TestSanitizeToolText(t *testing.T) {
	if got := sanitizeToolText("Dell\x1b[31m BIOS\r\n", 200); got != "Dell[31m BIOS" {
		t.Fatalf("control characters kept: %q", got)
	}
	if got := sanitizeToolText(string([]byte{0xff, 'a', 0xfe}), 200); got != "�a�" {
		t.Fatalf("invalid UTF-8 not replaced: %q", got)
	}
	long := strings.Repeat("é", 300)
	if got := sanitizeToolText(long, 200); len([]rune(got)) != 200 {
		t.Fatalf("truncated to %d runes, want 200", len([]rune(got)))
	}
}
