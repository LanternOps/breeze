package sessionbroker

import "testing"

func TestConsoleAtLoginWindow(t *testing.T) {
	b := New("/tmp/test-console-login-window.sock", nil)
	if b.ConsoleAtLoginWindow() {
		t.Fatal("an unset console user must not read as the login window")
	}
	b.SetConsoleUser("loginwindow")
	if !b.ConsoleAtLoginWindow() {
		t.Fatal("console user loginwindow must read as the login window")
	}
	b.SetConsoleUser("alice")
	if b.ConsoleAtLoginWindow() {
		t.Fatal("a signed-in console user must not read as the login window")
	}
}
