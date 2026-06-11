package tools

// utf8PowerShellCommand wraps a PowerShell command so its stdout is emitted as
// UTF-8. Without this, PowerShell renders output using the console OEM codepage
// (e.g. CP852 on Polish Windows), which Go then decodes as UTF-8 and corrupts
// non-Latin characters into U+FFFD. See issue #979.
func utf8PowerShellCommand(command string) string {
	return "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" + command
}
