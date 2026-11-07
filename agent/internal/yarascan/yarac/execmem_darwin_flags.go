//go:build darwin

package yarac

// xnu bsd/sys/codesign.h. CS_KILL (0x200) is deliberately not one of them:
// arm64 sets it on every linker-signed `go build` binary (csops status
// 0x22020201), and those run the engine fine. What gets an anonymous r-x page
// killed is enforcement — CS_HARD / CS_ENFORCEMENT, which the hardened
// runtime turns on (0x22011311 for the same binary re-signed with
// --options runtime).
const (
	csHard        = 0x00000100
	csEnforcement = 0x00001000
	csRuntime     = 0x00010000
)
