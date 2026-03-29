//go:build windows

package peripheral

import (
	"testing"
)

func TestClassifyWindowsBluetooth(t *testing.T) {
	pType, dClass := classifyWindows(`BTHENUM\{0000110E-0000-1000-8000-00805F9B34FB}`, "Bluetooth", "BTHUSB")
	if pType != "bluetooth" {
		t.Fatalf("peripheralType = %q, want %q", pType, "bluetooth")
	}
	if dClass != "bluetooth" {
		t.Fatalf("deviceClass = %q, want %q", dClass, "bluetooth")
	}
}

func TestClassifyWindowsBluetoothLowercase(t *testing.T) {
	// classifyWindows uppercases the DeviceID, so mixed case should work
	pType, dClass := classifyWindows(`bthenum\device`, "Bluetooth", "")
	if pType != "bluetooth" {
		t.Fatalf("peripheralType = %q, want %q", pType, "bluetooth")
	}
	if dClass != "bluetooth" {
		t.Fatalf("deviceClass = %q, want %q", dClass, "bluetooth")
	}
}

func TestClassifyWindowsUSBStor(t *testing.T) {
	pType, dClass := classifyWindows(`USBSTOR\DISK&VEN_SANDISK&PROD_ULTRA`, "", "")
	if pType != "usb" {
		t.Fatalf("peripheralType = %q, want %q", pType, "usb")
	}
	if dClass != "storage" {
		t.Fatalf("deviceClass = %q, want %q", dClass, "storage")
	}
}

func TestClassifyWindowsUSBStorService(t *testing.T) {
	// DeviceID starts with USB\ but service is "usbstor"
	pType, dClass := classifyWindows(`USB\VID_0781&PID_5583`, "", "USBSTOR")
	if pType != "usb" {
		t.Fatalf("peripheralType = %q, want %q", pType, "usb")
	}
	if dClass != "storage" {
		t.Fatalf("deviceClass = %q, want %q", dClass, "storage")
	}
}

func TestClassifyWindowsDiskService(t *testing.T) {
	pType, dClass := classifyWindows(`USB\VID_1234&PID_5678`, "", "disk")
	if pType != "usb" {
		t.Fatalf("peripheralType = %q, want %q", pType, "usb")
	}
	if dClass != "storage" {
		t.Fatalf("deviceClass = %q, want %q", dClass, "storage")
	}
}

func TestClassifyWindowsGenericUSB(t *testing.T) {
	pType, dClass := classifyWindows(`USB\VID_046D&PID_C31C`, "HID", "HidUsb")
	if pType != "usb" {
		t.Fatalf("peripheralType = %q, want %q", pType, "usb")
	}
	if dClass != "all_usb" {
		t.Fatalf("deviceClass = %q, want %q", dClass, "all_usb")
	}
}

func TestClassifyWindowsEmptyDeviceID(t *testing.T) {
	pType, dClass := classifyWindows("", "", "")
	if pType != "usb" {
		t.Fatalf("peripheralType = %q, want %q", pType, "usb")
	}
	if dClass != "all_usb" {
		t.Fatalf("deviceClass = %q, want %q", dClass, "all_usb")
	}
}

func TestClassifyWindowsServiceCaseInsensitive(t *testing.T) {
	// Service name should be case-insensitive
	pType, dClass := classifyWindows(`USB\VID_1234&PID_5678`, "", "UsbStor")
	if pType != "usb" {
		t.Fatalf("peripheralType = %q, want %q", pType, "usb")
	}
	if dClass != "storage" {
		t.Fatalf("deviceClass = %q, want %q", dClass, "storage")
	}
}
