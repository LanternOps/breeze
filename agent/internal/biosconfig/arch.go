package biosconfig

// IMAGE_FILE_MACHINE values IsWow64Process2 reports for the native machine.
const (
	imageFileMachineI386  = 0x014c
	imageFileMachineAMD64 = 0x8664
	imageFileMachineARM64 = 0xAA64
)

func archOf(machine uint16) string {
	switch machine {
	case imageFileMachineAMD64:
		return "amd64"
	case imageFileMachineARM64:
		return "arm64"
	case imageFileMachineI386:
		return "x86"
	}
	return "unknown"
}
