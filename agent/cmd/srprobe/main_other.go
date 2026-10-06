//go:build !windows

package main

import "fmt"

func main() {
	fmt.Println("srprobe is Windows-only; nothing to do on this platform")
}
