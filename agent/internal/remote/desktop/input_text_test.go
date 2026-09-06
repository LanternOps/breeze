package desktop

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

// ---- test doubles -------------------------------------------------------

// recordingHandler implements InputHandler and records every call. Embedding it
// in the more capable fakes below keeps each fake to just the extra method, so
// the type assertions in InjectText are what distinguishes them.
type recordingHandler struct {
	keyPresses []recordedKeyPress
	keyErr     error
}

type recordedKeyPress struct {
	key       string
	modifiers []string
}

func (h *recordingHandler) SetDisplayOffset(int, int)             {}
func (h *recordingHandler) SendMouseMove(int, int) error          { return nil }
func (h *recordingHandler) SendMouseClick(int, int, string) error { return nil }
func (h *recordingHandler) SendMouseDown(int, int, string) error  { return nil }
func (h *recordingHandler) SendMouseUp(int, int, string) error    { return nil }
func (h *recordingHandler) SendMouseScroll(int, int, int) error   { return nil }
func (h *recordingHandler) SendKeyDown(string) error              { return nil }
func (h *recordingHandler) SendKeyUp(string) error                { return nil }
func (h *recordingHandler) HandleEvent(InputEvent) error          { return nil }
func (h *recordingHandler) InputAvailable() bool                  { return true }
func (h *recordingHandler) SetAtLoginWindow(bool)                 {}
func (h *recordingHandler) SendKeyPress(key string, mods []string) error {
	if h.keyErr != nil {
		return h.keyErr
	}
	h.keyPresses = append(h.keyPresses, recordedKeyPress{key: key, modifiers: mods})
	return nil
}

// textTyperHandler additionally implements TextTyper (the macOS/Windows shape).
type textTyperHandler struct {
	recordingHandler
	texts   []string
	textErr error
}

func (h *textTyperHandler) TypeText(text string) error {
	if h.textErr != nil {
		return h.textErr
	}
	h.texts = append(h.texts, text)
	return nil
}

// charTyperHandler additionally implements TypeCharHandler but not TextTyper.
type charTyperHandler struct {
	recordingHandler
	runes []rune
}

func (h *charTyperHandler) TypeChar(ch rune) error {
	h.runes = append(h.runes, ch)
	return nil
}

// ---- splitTextSegments --------------------------------------------------

func TestSplitTextSegments(t *testing.T) {
	lit := func(s string) textSegment { return textSegment{Literal: s} }
	key := func(k string) textSegment { return textSegment{Key: k} }

	tests := []struct {
		name string
		in   string
		want []textSegment
	}{
		{"empty", "", nil},
		{"plain", "echo hi", []textSegment{lit("echo hi")}},
		{"lf splits", "a\nb", []textSegment{lit("a"), key("return"), lit("b")}},
		{"crlf collapses to one return", "a\r\nb", []textSegment{lit("a"), key("return"), lit("b")}},
		{"lone cr is a return", "a\rb", []textSegment{lit("a"), key("return"), lit("b")}},
		{"tab", "a\tb", []textSegment{lit("a"), key("tab"), lit("b")}},
		{"consecutive newlines each emit a return", "a\n\nb", []textSegment{lit("a"), key("return"), key("return"), lit("b")}},
		{"leading and trailing newline", "\na\n", []textSegment{key("return"), lit("a"), key("return")}},
		{"only newlines", "\r\n\n", []textSegment{key("return"), key("return")}},
		{
			"shell block keeps punctuation in the literal run",
			"cd /usr/local/bin\necho \"===== HOST =====\"",
			[]textSegment{
				lit("cd /usr/local/bin"),
				key("return"),
				lit("echo \"===== HOST =====\""),
			},
		},
		{"non-ascii stays in the literal run", "café ☕", []textSegment{lit("café ☕")}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := splitTextSegments(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("splitTextSegments(%q)\n got: %#v\nwant: %#v", tc.in, got, tc.want)
			}
		})
	}
}

// ---- chunkUTF16 ---------------------------------------------------------

func TestChunkUTF16(t *testing.T) {
	tests := []struct {
		name string
		in   string
		max  int
		want [][]uint16
	}{
		{"empty", "", 4, nil},
		{"fits in one chunk", "abc", 4, [][]uint16{{'a', 'b', 'c'}}},
		{"exact multiple", "abcd", 2, [][]uint16{{'a', 'b'}, {'c', 'd'}}},
		{"remainder", "abcde", 2, [][]uint16{{'a', 'b'}, {'c', 'd'}, {'e'}}},
		{
			"surrogate pair is never split across chunks",
			"a\U0001F600b", // 'a', high+low surrogate, 'b' == 4 UTF-16 units
			2,
			[][]uint16{{'a'}, {0xD83D, 0xDE00}, {'b'}},
		},
		{
			"surrogate pair emitted whole even when it exceeds the cap",
			"\U0001F600",
			1,
			[][]uint16{{0xD83D, 0xDE00}},
		},
		{
			"bmp non-ascii is one unit",
			"éé",
			1,
			[][]uint16{{0x00E9}, {0x00E9}},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := chunkUTF16(tc.in, tc.max)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("chunkUTF16(%q, %d)\n got: %v\nwant: %v", tc.in, tc.max, got, tc.want)
			}
			// Every chunk must round-trip back to the original string.
			var rebuilt []uint16
			for _, c := range got {
				rebuilt = append(rebuilt, c...)
			}
			if s := utf16ToString(rebuilt); s != tc.in {
				t.Fatalf("chunks do not reassemble: got %q want %q", s, tc.in)
			}
		})
	}
}

// ---- charToKeyPress (the no-unicode fallback mapping) -------------------

func TestCharToKeyPress(t *testing.T) {
	tests := []struct {
		in   rune
		key  string
		mods []string
		ok   bool
	}{
		{'a', "a", nil, true},
		{'Z', "z", []string{"shift"}, true},
		{'7', "7", nil, true},
		{'?', "/", []string{"shift"}, true},
		{'+', "=", []string{"shift"}, true},
		{'|', "\\", []string{"shift"}, true},
		{' ', " ", nil, true},
		{'/', "/", nil, true},
		{'é', "", nil, false},
		{'\U0001F600', "", nil, false},
	}

	for _, tc := range tests {
		t.Run(string(tc.in), func(t *testing.T) {
			key, mods, ok := charToKeyPress(tc.in)
			if ok != tc.ok || key != tc.key || !reflect.DeepEqual(mods, tc.mods) {
				t.Fatalf("charToKeyPress(%q) = (%q, %v, %v), want (%q, %v, %v)",
					tc.in, key, mods, ok, tc.key, tc.mods, tc.ok)
			}
		})
	}
}

// charToKeyPress must agree with the viewer's SHIFTED_TO_BASE table in
// apps/viewer/src/lib/paste.ts — the two are the same contract, one per side.
func TestCharToKeyPressMatchesViewerShiftTable(t *testing.T) {
	viewer := map[rune]string{
		'~': "`", '!': "1", '@': "2", '#': "3", '$': "4",
		'%': "5", '^': "6", '&': "7", '*': "8", '(': "9",
		')': "0", '_': "-", '+': "=", '{': "[", '}': "]",
		'|': "\\", ':': ";", '"': "'", '<': ",", '>': ".",
		'?': "/",
	}
	for ch, base := range viewer {
		key, mods, ok := charToKeyPress(ch)
		if !ok || key != base || len(mods) != 1 || mods[0] != "shift" {
			t.Errorf("charToKeyPress(%q) = (%q, %v, %v), want (%q, [shift], true)", ch, key, mods, ok, base)
		}
	}
}

// ---- InjectText ---------------------------------------------------------

func TestInjectTextPrefersTypeText(t *testing.T) {
	h := &textTyperHandler{}
	if err := InjectText(h, "cd /usr/local/bin\necho \"a=b\"\t!"); err != nil {
		t.Fatalf("InjectText: %v", err)
	}

	wantTexts := []string{"cd /usr/local/bin", "echo \"a=b\"", "!"}
	if !reflect.DeepEqual(h.texts, wantTexts) {
		t.Fatalf("literal runs: got %q want %q", h.texts, wantTexts)
	}
	wantKeys := []recordedKeyPress{{key: "return"}, {key: "tab"}}
	if !reflect.DeepEqual(h.keyPresses, wantKeys) {
		t.Fatalf("key presses: got %#v want %#v", h.keyPresses, wantKeys)
	}
}

func TestInjectTextFallsBackToTypeChar(t *testing.T) {
	h := &charTyperHandler{}
	if err := InjectText(h, "a€\nb"); err != nil {
		t.Fatalf("InjectText: %v", err)
	}
	if got, want := string(h.runes), "a€b"; got != want {
		t.Fatalf("runes: got %q want %q", got, want)
	}
	if len(h.keyPresses) != 1 || h.keyPresses[0].key != "return" {
		t.Fatalf("expected a single return key press, got %#v", h.keyPresses)
	}
}

func TestInjectTextFallsBackToKeySynthesis(t *testing.T) {
	h := &recordingHandler{}
	if err := InjectText(h, "A?\nb"); err != nil {
		t.Fatalf("InjectText: %v", err)
	}
	want := []recordedKeyPress{
		{key: "a", modifiers: []string{"shift"}},
		{key: "/", modifiers: []string{"shift"}},
		{key: "return"},
		{key: "b"},
	}
	if !reflect.DeepEqual(h.keyPresses, want) {
		t.Fatalf("key presses: got %#v want %#v", h.keyPresses, want)
	}
}

// A handler with no unicode capability cannot type non-ASCII. Those characters
// are skipped, but InjectText must SAY SO rather than dropping them silently.
func TestInjectTextReportsUnmappableCharactersOnKeySynthesisFallback(t *testing.T) {
	h := &recordingHandler{}
	err := InjectText(h, "café ☕")
	if err == nil {
		t.Fatal("expected an error reporting the skipped characters, got nil")
	}
	if !strings.Contains(err.Error(), "2 character(s)") {
		t.Fatalf("error should report how many characters were skipped, got %q", err.Error())
	}
	// Everything mappable must still have been typed.
	var typed strings.Builder
	for _, kp := range h.keyPresses {
		typed.WriteString(kp.key)
	}
	if got, want := typed.String(), "caf "; got != want {
		t.Fatalf("mappable characters: got %q want %q", got, want)
	}
}

// The error must not carry the clipboard content itself — a paste can be a
// password, and this error is written to the agent's log.
func TestInjectTextErrorsNeverEchoClipboardContent(t *testing.T) {
	secret := "hunter2-ünïcode"
	err := InjectText(&recordingHandler{}, secret)
	if err == nil {
		t.Fatal("expected an error for the unmappable characters")
	}
	for _, fragment := range []string{"hunter2", "ü", "ï"} {
		if strings.Contains(err.Error(), fragment) {
			t.Fatalf("error leaked clipboard content %q: %q", fragment, err.Error())
		}
	}
}

// bothTyperHandler implements TextTyper AND TypeCharHandler, like the real
// macOS and Windows handlers do. Without it nothing pins the dispatch ORDER —
// a switch that checked TypeCharHandler first would still produce the right
// characters, just one CGEvent/SendInput call per character instead of one per
// run.
type bothTyperHandler struct {
	recordingHandler
	texts []string
	runes []rune
}

func (h *bothTyperHandler) TypeText(text string) error {
	h.texts = append(h.texts, text)
	return nil
}

func (h *bothTyperHandler) TypeChar(ch rune) error {
	h.runes = append(h.runes, ch)
	return nil
}

func TestInjectTextPrefersTypeTextOverTypeChar(t *testing.T) {
	h := &bothTyperHandler{}
	if err := InjectText(h, "echo hi"); err != nil {
		t.Fatalf("InjectText: %v", err)
	}
	if len(h.texts) != 1 || h.texts[0] != "echo hi" {
		t.Fatalf("expected one whole-string TypeText call, got %q", h.texts)
	}
	if len(h.runes) != 0 {
		t.Fatalf("expected TypeChar not to be used when TypeText exists, got %q", string(h.runes))
	}
}

func TestInjectTextEmpty(t *testing.T) {
	h := &textTyperHandler{}
	if err := InjectText(h, ""); err != nil {
		t.Fatalf("InjectText(\"\"): %v", err)
	}
	if len(h.texts) != 0 || len(h.keyPresses) != 0 {
		t.Fatalf("empty text must inject nothing, got texts=%q keys=%#v", h.texts, h.keyPresses)
	}
}

func TestInjectTextPropagatesTypeTextError(t *testing.T) {
	sentinel := errors.New("boom")
	h := &textTyperHandler{textErr: sentinel}
	err := InjectText(h, "abc")
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected the TypeText error to propagate, got %v", err)
	}
}

func TestInjectTextPropagatesKeyPressError(t *testing.T) {
	sentinel := errors.New("nope")
	h := &textTyperHandler{}
	h.keyErr = sentinel
	err := InjectText(h, "a\nb")
	if !errors.Is(err, sentinel) {
		t.Fatalf("expected the SendKeyPress error to propagate, got %v", err)
	}
}

func TestInjectTextNilHandler(t *testing.T) {
	if err := InjectText(nil, "abc"); err == nil {
		t.Fatal("expected an error for a nil handler")
	}
}

// utf16ToString is a test helper: it rebuilds a Go string from UTF-16 units so
// the chunker can be checked for lossless round-tripping.
func utf16ToString(units []uint16) string {
	if len(units) == 0 {
		return ""
	}
	var b strings.Builder
	for i := 0; i < len(units); i++ {
		u := units[i]
		if u >= 0xD800 && u <= 0xDBFF && i+1 < len(units) {
			lo := units[i+1]
			if lo >= 0xDC00 && lo <= 0xDFFF {
				b.WriteRune(rune(0x10000 + (rune(u)-0xD800)<<10 + (rune(lo) - 0xDC00)))
				i++
				continue
			}
		}
		b.WriteRune(rune(u))
	}
	return b.String()
}
