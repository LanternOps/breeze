package peripheral

import (
	"testing"
	"time"
)

func TestFieldMatchesEmpty(t *testing.T) {
	// Empty rule value acts as wildcard — matches anything.
	if !fieldMatches("", "anything") {
		t.Fatal("empty rule should match any device value")
	}
	if !fieldMatches("", "") {
		t.Fatal("empty rule should match empty device value")
	}
}

func TestFieldMatchesExact(t *testing.T) {
	if !fieldMatches("SanDisk", "SanDisk") {
		t.Fatal("exact match should succeed")
	}
}

func TestFieldMatchesCaseInsensitive(t *testing.T) {
	if !fieldMatches("sandisk", "SanDisk") {
		t.Fatal("case-insensitive match should succeed")
	}
	if !fieldMatches("SANDISK", "sandisk") {
		t.Fatal("case-insensitive match should succeed (upper vs lower)")
	}
}

func TestFieldMatchesMismatch(t *testing.T) {
	if fieldMatches("Kingston", "SanDisk") {
		t.Fatal("mismatched values should not match")
	}
}

func TestClassMatchesExact(t *testing.T) {
	tests := []struct {
		policyClass string
		deviceClass string
		want        bool
	}{
		{"storage", "storage", true},
		{"bluetooth", "bluetooth", true},
		{"thunderbolt", "thunderbolt", true},
		{"all_usb", "all_usb", true},
	}
	for _, tt := range tests {
		if got := classMatches(tt.policyClass, tt.deviceClass); got != tt.want {
			t.Fatalf("classMatches(%q, %q) = %v, want %v", tt.policyClass, tt.deviceClass, got, tt.want)
		}
	}
}

func TestClassMatchesAllUSBCoversStorage(t *testing.T) {
	if !classMatches("all_usb", "storage") {
		t.Fatal("all_usb policy should cover storage devices")
	}
	if !classMatches("all_usb", "all_usb") {
		t.Fatal("all_usb policy should cover all_usb devices")
	}
}

func TestClassMatchesDoesNotCrossCover(t *testing.T) {
	// storage policy should NOT cover all_usb devices
	if classMatches("storage", "all_usb") {
		t.Fatal("storage policy should not cover all_usb devices")
	}
	// bluetooth should NOT match storage
	if classMatches("bluetooth", "storage") {
		t.Fatal("bluetooth policy should not cover storage devices")
	}
	// storage should NOT match bluetooth
	if classMatches("storage", "bluetooth") {
		t.Fatal("storage policy should not cover bluetooth devices")
	}
}

func TestMatchesExceptionBasicMatch(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor:  "SanDisk",
		Product: "Ultra",
	}
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Allow: true, Reason: "approved"},
	}

	matched, ex := matchesException(dev, exceptions)
	if !matched {
		t.Fatal("exception should match by vendor")
	}
	if ex.Reason != "approved" {
		t.Fatalf("matched exception reason = %q, want %q", ex.Reason, "approved")
	}
}

func TestMatchesExceptionSerialNumber(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor:       "SanDisk",
		Product:      "Ultra",
		SerialNumber: "ABC123",
	}
	exceptions := []ExceptionRule{
		{SerialNumber: "ABC123", Allow: true},
	}

	matched, _ := matchesException(dev, exceptions)
	if !matched {
		t.Fatal("exception should match by serial number")
	}
}

func TestMatchesExceptionMultipleFields(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor:       "SanDisk",
		Product:      "Ultra",
		SerialNumber: "ABC123",
	}
	// All three fields specified and all match
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Product: "Ultra", SerialNumber: "ABC123", Allow: true},
	}

	matched, _ := matchesException(dev, exceptions)
	if !matched {
		t.Fatal("exception should match when all fields match")
	}
}

func TestMatchesExceptionPartialFieldMismatch(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor:       "SanDisk",
		Product:      "Ultra",
		SerialNumber: "ABC123",
	}
	// Vendor matches but serial doesn't
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", SerialNumber: "WRONG", Allow: true},
	}

	matched, _ := matchesException(dev, exceptions)
	if matched {
		t.Fatal("exception should not match when serial number mismatches")
	}
}

func TestMatchesExceptionEmptyFieldsSkipped(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor:  "SanDisk",
		Product: "Ultra",
	}
	// Exception with no fields specified — should not match
	exceptions := []ExceptionRule{
		{Allow: true, Reason: "blank rule"},
	}

	matched, _ := matchesException(dev, exceptions)
	if matched {
		t.Fatal("exception with no vendor/product/serial should not match")
	}
}

func TestMatchesExceptionAllowFalseDoesNotMatch(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor: "SanDisk",
	}
	// Vendor matches but Allow is false
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Allow: false},
	}

	matched, _ := matchesException(dev, exceptions)
	if matched {
		t.Fatal("exception with Allow=false should not return matched=true")
	}
}

func TestMatchesExceptionExpired(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor: "SanDisk",
	}
	pastTime := time.Now().Add(-24 * time.Hour).Format(time.RFC3339)
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Allow: true, ExpiresAt: pastTime},
	}

	matched, _ := matchesException(dev, exceptions)
	if matched {
		t.Fatal("expired exception should not match")
	}
}

func TestMatchesExceptionNotYetExpired(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor: "SanDisk",
	}
	futureTime := time.Now().Add(24 * time.Hour).Format(time.RFC3339)
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Allow: true, ExpiresAt: futureTime},
	}

	matched, _ := matchesException(dev, exceptions)
	if !matched {
		t.Fatal("non-expired exception should match")
	}
}

func TestMatchesExceptionInvalidExpiryTreatedAsNoExpiry(t *testing.T) {
	dev := DetectedPeripheral{
		Vendor: "SanDisk",
	}
	// Invalid date string — parse fails, treated as non-expired
	exceptions := []ExceptionRule{
		{Vendor: "SanDisk", Allow: true, ExpiresAt: "not-a-date"},
	}

	matched, _ := matchesException(dev, exceptions)
	if !matched {
		t.Fatal("exception with unparseable expiry should still match (treated as non-expired)")
	}
}

func TestMatchesExceptionNoExceptions(t *testing.T) {
	dev := DetectedPeripheral{Vendor: "SanDisk"}
	matched, _ := matchesException(dev, nil)
	if matched {
		t.Fatal("nil exceptions list should not match")
	}

	matched, _ = matchesException(dev, []ExceptionRule{})
	if matched {
		t.Fatal("empty exceptions list should not match")
	}
}

func TestEvaluateOneNoPolicy(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		Vendor:         "SanDisk",
		DeviceClass:    "storage",
	}

	result := evaluateOne(dev, nil)
	if result.Policy != nil {
		t.Fatal("no policies should yield nil Policy")
	}
	if result.Action != "" {
		t.Fatalf("Action = %q, want empty", result.Action)
	}
	if result.Excepted {
		t.Fatal("Excepted should be false with no policy")
	}
}

func TestEvaluateOneInactivePolicySkipped(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		Vendor:         "SanDisk",
		DeviceClass:    "storage",
	}
	policies := []Policy{
		{
			ID:          "pol-1",
			Name:        "Block storage",
			DeviceClass: "storage",
			Action:      "block",
			IsActive:    false,
		},
	}

	result := evaluateOne(dev, policies)
	if result.Policy != nil {
		t.Fatal("inactive policy should be skipped — expected nil Policy")
	}
}

func TestEvaluateOneClassMismatchSkipped(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		DeviceClass:    "storage",
	}
	policies := []Policy{
		{
			ID:          "pol-bt",
			DeviceClass: "bluetooth",
			Action:      "block",
			IsActive:    true,
		},
	}

	result := evaluateOne(dev, policies)
	if result.Policy != nil {
		t.Fatal("policy with mismatched class should be skipped")
	}
}

func TestEvaluateOneFirstMatchWins(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		DeviceClass:    "storage",
	}
	policies := []Policy{
		{
			ID:          "pol-1",
			Name:        "Alert on storage",
			DeviceClass: "storage",
			Action:      "alert",
			IsActive:    true,
		},
		{
			ID:          "pol-2",
			Name:        "Block storage",
			DeviceClass: "storage",
			Action:      "block",
			IsActive:    true,
		},
	}

	result := evaluateOne(dev, policies)
	if result.Policy == nil {
		t.Fatal("expected a matching policy")
	}
	if result.Policy.ID != "pol-1" {
		t.Fatalf("Policy.ID = %q, want %q (first match wins)", result.Policy.ID, "pol-1")
	}
	if result.Action != "alert" {
		t.Fatalf("Action = %q, want %q", result.Action, "alert")
	}
}

func TestEvaluateOneWithException(t *testing.T) {
	dev := DetectedPeripheral{
		PeripheralType: "usb",
		Vendor:         "SanDisk",
		Product:        "Ultra",
		DeviceClass:    "storage",
	}
	policies := []Policy{
		{
			ID:          "pol-1",
			Name:        "Block storage",
			DeviceClass: "storage",
			Action:      "block",
			IsActive:    true,
			Exceptions: []ExceptionRule{
				{Vendor: "SanDisk", Allow: true, Reason: "IT-approved"},
			},
		},
	}

	result := evaluateOne(dev, policies)
	if result.Policy == nil {
		t.Fatal("expected matching policy")
	}
	if !result.Excepted {
		t.Fatal("expected Excepted=true for exception match")
	}
	if result.Action != "allow" {
		t.Fatalf("Action = %q, want %q (exception overrides block)", result.Action, "allow")
	}
}

