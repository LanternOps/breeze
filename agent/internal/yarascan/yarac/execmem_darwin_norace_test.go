//go:build darwin && cgo && !race

package yarac

// raceEnabled lets the darwin hardened-runtime test skip under -race.
const raceEnabled = false
