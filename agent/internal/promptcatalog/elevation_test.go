package promptcatalog

import (
	"errors"
	"testing"
)

// The elevation namespace (W07) ships embedded: the agent renders every
// elevation.request string from it.
func TestEmbeddedCatalogCarriesTheElevationNamespace(t *testing.T) {
	cat, err := load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(cat["elevation"]) == 0 {
		t.Fatal(`namespace "elevation" is not embedded`)
	}
	got, err := Render(Locale("de-DE"), "elevation", "action.cancelRequest", nil)
	if err != nil || got != "Anfrage zurückziehen" {
		t.Fatalf("elevation/action.cancelRequest in de-DE = %q, %v", got, err)
	}
	// A {time:<ms>} value passed for {until} is left for the renderer.
	got, err = Render(LocaleEN, "elevation", "waiting.deadline", map[string]string{"until": "{time:1793016900000}"})
	if err != nil || got != "The request stays open until {time:1793016900000}." {
		t.Fatalf("waiting.deadline = %q, %v", got, err)
	}
	if _, err := Render(LocaleEN, "elevation", "approved.bodyFrom", map[string]string{"technician": "Dana", "program": "7zFM.exe"}); !errors.Is(err, ErrMissingParam) {
		t.Fatalf("approved.bodyFrom without partner: err = %v, want ErrMissingParam", err)
	}
}
