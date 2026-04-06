package tools

import (
	"strings"
	"testing"
)

func TestValidateComputerActionInputRejectsOversizedFields(t *testing.T) {
	if _, _, _, err := validateComputerActionInput(strings.Repeat("t", maxComputerActionTextBytes+1), "", nil); err == nil {
		t.Fatal("expected oversized text to fail")
	}
	if _, _, _, err := validateComputerActionInput("", strings.Repeat("k", maxComputerActionKeyBytes+1), nil); err == nil {
		t.Fatal("expected oversized key to fail")
	}
	if _, _, _, err := validateComputerActionInput("", "", make([]string, maxComputerActionModifiers+1)); err == nil {
		t.Fatal("expected too many modifiers to fail")
	}
	if _, _, _, err := validateComputerActionInput("", "", []string{strings.Repeat("m", maxComputerActionKeyBytes+1)}); err == nil {
		t.Fatal("expected oversized modifier to fail")
	}
}

func TestValidateComputerActionInputAcceptsBoundedFields(t *testing.T) {
	text, key, modifiers, err := validateComputerActionInput("hello", "enter", []string{"shift", "ctrl"})
	if err != nil {
		t.Fatalf("expected bounded input to succeed, got %v", err)
	}
	if text != "hello" || key != "enter" {
		t.Fatalf("unexpected validated values: %q %q", text, key)
	}
	if len(modifiers) != 2 {
		t.Fatalf("expected 2 modifiers, got %d", len(modifiers))
	}
}
