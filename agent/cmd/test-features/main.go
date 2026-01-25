//go:build darwin

package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Usage: test-features <software|capture|input>")
		return
	}

	switch os.Args[1] {
	case "software":
		testSoftware()
	case "capture":
		testCapture()
	case "input":
		testInput()
	default:
		fmt.Println("Unknown test:", os.Args[1])
	}
}

func testSoftware() {
	fmt.Println("=== Testing Software Inventory (macOS) ===")
	c := collectors.NewSoftwareCollector()
	items, err := c.Collect()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}
	fmt.Printf("Found %d installed applications\n\n", len(items))
	
	// Show first 5
	for i, item := range items {
		if i >= 5 { break }
		b, _ := json.MarshalIndent(item, "", "  ")
		fmt.Println(string(b))
	}
	if len(items) > 5 {
		fmt.Println("\n... and", len(items)-5, "more")
	}
}

func testCapture() {
	fmt.Println("=== Testing Screen Capture (macOS) ===")
	cfg := desktop.DefaultConfig()
	cap, err := desktop.NewScreenCapturer(cfg)
	if err != nil {
		fmt.Printf("Error creating capturer: %v\n", err)
		return
	}
	defer cap.Close()
	
	img, err := cap.Capture()
	if err != nil {
		fmt.Printf("Error capturing: %v\n", err)
		return
	}
	
	fmt.Printf("Captured screen: %dx%d\n", img.Bounds().Dx(), img.Bounds().Dy())
	fmt.Println("Screen capture working!")
}

func testInput() {
	fmt.Println("=== Testing Input Handler (macOS) ===")
	handler := desktop.NewInputHandler()
	
	// Test mouse move (safe - just moves cursor slightly)
	fmt.Println("Testing mouse move...")
	if err := handler.SendMouseMove(100, 100); err != nil {
		fmt.Printf("Mouse move error: %v\n", err)
	} else {
		fmt.Println("Mouse move: OK")
	}
	
	fmt.Println("\nInput handler initialized (not executing keys for safety)")
}
