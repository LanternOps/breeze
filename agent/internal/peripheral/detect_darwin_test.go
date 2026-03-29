//go:build darwin

package peripheral

import (
	"testing"
)

func TestIsHub(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"USB Hub", true},
		{"USB3.0 Hub", true},
		{"Root Hub Simulation", true},
		{"hub", true},
		{"HUB", true},
		{"SanDisk Ultra", false},
		{"Logitech Keyboard", false},
		{"", false},
		{"Thunderbolt", false},
	}

	for _, tt := range tests {
		if got := isHub(tt.name); got != tt.want {
			t.Errorf("isHub(%q) = %v, want %v", tt.name, got, tt.want)
		}
	}
}

func TestCollectUSBItemsSimpleDevice(t *testing.T) {
	item := spUSBItem{
		Name:         "Ultra USB 3.0",
		VendorID:     "0x0781",
		ProductID:    "0x5583",
		Manufacturer: "SanDisk",
		SerialNum:    "4C530001",
	}

	var result []DetectedPeripheral
	collectUSBItems(item, &result)

	if len(result) != 1 {
		t.Fatalf("got %d peripherals, want 1", len(result))
	}

	dev := result[0]
	if dev.PeripheralType != "usb" {
		t.Fatalf("PeripheralType = %q, want %q", dev.PeripheralType, "usb")
	}
	if dev.Vendor != "SanDisk" {
		t.Fatalf("Vendor = %q, want %q", dev.Vendor, "SanDisk")
	}
	if dev.Product != "Ultra USB 3.0" {
		t.Fatalf("Product = %q, want %q", dev.Product, "Ultra USB 3.0")
	}
	if dev.SerialNumber != "4C530001" {
		t.Fatalf("SerialNumber = %q, want %q", dev.SerialNumber, "4C530001")
	}
	if dev.DeviceClass != "all_usb" {
		t.Fatalf("DeviceClass = %q, want %q (no Media)", dev.DeviceClass, "all_usb")
	}
	if dev.DeviceID != "0x0781:0x5583" {
		t.Fatalf("DeviceID = %q, want %q", dev.DeviceID, "0x0781:0x5583")
	}
}

func TestCollectUSBItemsStorageDevice(t *testing.T) {
	item := spUSBItem{
		Name:         "External HDD",
		VendorID:     "0x1234",
		ProductID:    "0x5678",
		Manufacturer: "Seagate",
		Media:        []spMedia{{Name: "Seagate Backup Plus"}},
	}

	var result []DetectedPeripheral
	collectUSBItems(item, &result)

	if len(result) != 1 {
		t.Fatalf("got %d peripherals, want 1", len(result))
	}
	if result[0].DeviceClass != "storage" {
		t.Fatalf("DeviceClass = %q, want %q (has Media)", result[0].DeviceClass, "storage")
	}
}

func TestCollectUSBItemsVendorFallbackToVendorID(t *testing.T) {
	item := spUSBItem{
		Name:     "Generic Device",
		VendorID: "0x1234",
		// Manufacturer is empty
	}

	var result []DetectedPeripheral
	collectUSBItems(item, &result)

	if len(result) != 1 {
		t.Fatalf("got %d peripherals, want 1", len(result))
	}
	if result[0].Vendor != "0x1234" {
		t.Fatalf("Vendor = %q, want %q (fallback to VendorID)", result[0].Vendor, "0x1234")
	}
}

func TestCollectUSBItemsSkipsHub(t *testing.T) {
	item := spUSBItem{
		Name:     "USB3.0 Hub",
		VendorID: "0x0424",
	}

	var result []DetectedPeripheral
	collectUSBItems(item, &result)

	if len(result) != 0 {
		t.Fatalf("got %d peripherals for hub, want 0 (should skip)", len(result))
	}
}

func TestCollectUSBItemsSkipsEmptyName(t *testing.T) {
	item := spUSBItem{
		Name:     "",
		VendorID: "0x1234",
	}

	var result []DetectedPeripheral
	collectUSBItems(item, &result)

	if len(result) != 0 {
		t.Fatalf("got %d peripherals for empty name, want 0", len(result))
	}
}

func TestCollectUSBItemsNestedDevices(t *testing.T) {
	// Simulate a hub with nested devices
	hub := spUSBItem{
		Name:     "USB2.0 Hub",
		VendorID: "0x0424",
		Items: []spUSBItem{
			{
				Name:         "Keyboard",
				VendorID:     "0x046d",
				ProductID:    "0xc31c",
				Manufacturer: "Logitech",
			},
			{
				Name:         "Mouse",
				VendorID:     "0x046d",
				ProductID:    "0xc077",
				Manufacturer: "Logitech",
			},
		},
	}

	var result []DetectedPeripheral
	collectUSBItems(hub, &result)

	// Hub itself should be skipped, but the two children should be collected
	if len(result) != 2 {
		t.Fatalf("got %d peripherals, want 2 (hub skipped, children collected)", len(result))
	}
	if result[0].Product != "Keyboard" {
		t.Fatalf("result[0].Product = %q, want %q", result[0].Product, "Keyboard")
	}
	if result[1].Product != "Mouse" {
		t.Fatalf("result[1].Product = %q, want %q", result[1].Product, "Mouse")
	}
}

func TestCollectUSBItemsDeepNesting(t *testing.T) {
	// Hub -> Sub-hub -> Device
	root := spUSBItem{
		Name:     "Root Hub",
		VendorID: "0x0001",
		Items: []spUSBItem{
			{
				Name:     "Sub Hub",
				VendorID: "0x0002",
				Items: []spUSBItem{
					{
						Name:         "Webcam",
						VendorID:     "0x046d",
						ProductID:    "0x0825",
						Manufacturer: "Logitech",
					},
				},
			},
		},
	}

	var result []DetectedPeripheral
	collectUSBItems(root, &result)

	if len(result) != 1 {
		t.Fatalf("got %d peripherals, want 1 (only leaf device)", len(result))
	}
	if result[0].Product != "Webcam" {
		t.Fatalf("Product = %q, want %q", result[0].Product, "Webcam")
	}
}

func TestCollectUSBItemsDeviceUnderHub(t *testing.T) {
	// A non-hub device at the top level with children (unusual but possible)
	top := spUSBItem{
		Name:         "Dock Station",
		VendorID:     "0x17e9",
		ProductID:    "0x0381",
		Manufacturer: "DisplayLink",
		Items: []spUSBItem{
			{
				Name:         "USB Flash Drive",
				VendorID:     "0x0781",
				ProductID:    "0x5583",
				Manufacturer: "SanDisk",
				Media:        []spMedia{{Name: "SanDisk"}},
			},
		},
	}

	var result []DetectedPeripheral
	collectUSBItems(top, &result)

	// Both the dock and the flash drive should be collected
	if len(result) != 2 {
		t.Fatalf("got %d peripherals, want 2 (dock + flash drive)", len(result))
	}
	if result[0].Product != "Dock Station" {
		t.Fatalf("result[0].Product = %q, want %q", result[0].Product, "Dock Station")
	}
	if result[0].DeviceClass != "all_usb" {
		t.Fatalf("result[0].DeviceClass = %q, want %q", result[0].DeviceClass, "all_usb")
	}
	if result[1].Product != "USB Flash Drive" {
		t.Fatalf("result[1].Product = %q, want %q", result[1].Product, "USB Flash Drive")
	}
	if result[1].DeviceClass != "storage" {
		t.Fatalf("result[1].DeviceClass = %q, want %q", result[1].DeviceClass, "storage")
	}
}
