package desktop

import (
	"fmt"
	"strings"
	"unicode/utf16"
)

// Literal-text injection for the viewer's "Paste Text" action (issue #4089).
//
// Paste used to be per-character keystroke synthesis: the viewer turned the
// clipboard into one `key_press` per character and the agent replayed each one
// through a hardcoded US-ANSI QWERTY virtual-keycode table. On a remote machine
// whose active input source is not US ANSI that table produces the *wrong*
// characters — `/` arriving as `?`, `=` as `+` — which silently corrupts pasted
// shell commands.
//
// The fix is to stop round-tripping through keycodes: platforms that can inject
// a literal Unicode string (macOS CGEventKeyboardSetUnicodeString, Windows
// KEYEVENTF_UNICODE) receive the text verbatim and the remote layout never
// enters into it. Platforms without such a primitive (Linux/XTEST) fall back to
// the same key synthesis as before, so their behaviour is unchanged.

// textSegment is one piece of a text payload. Exactly one of Literal and Key is
// set: Literal is a run of characters to deliver verbatim, Key is a named key to
// press. Newlines and tabs become real key presses rather than literal
// characters because a Return *keystroke* is what makes a multi-line shell block
// execute in a terminal — a U+000A inside a literal string does not.
type textSegment struct {
	Literal string
	Key     string
}

// shiftedToBase maps a shifted US-layout symbol to the unshifted key that
// produces it. Mirrors SHIFTED_TO_BASE in apps/viewer/src/lib/paste.ts — the two
// halves of the same contract, and TestCharToKeyPressMatchesViewerShiftTable
// pins them together.
var shiftedToBase = map[rune]string{
	'~': "`", '!': "1", '@': "2", '#': "3", '$': "4",
	'%': "5", '^': "6", '&': "7", '*': "8", '(': "9",
	')': "0", '_': "-", '+': "=", '{': "[", '}': "]",
	'|': "\\", ':': ";", '"': "'", '<': ",", '>': ".",
	'?': "/",
}

// splitTextSegments splits text into literal runs interleaved with the control
// keys that have to be delivered as real key presses. CRLF collapses to a single
// Return, matching textToKeyEvents in apps/viewer/src/lib/paste.ts.
//
// Scanning bytes is safe: '\r', '\n' and '\t' are ASCII, and no byte of a
// multi-byte UTF-8 sequence is ever below 0x80.
func splitTextSegments(text string) []textSegment {
	var (
		segments []textSegment
		literal  strings.Builder
	)
	flush := func() {
		if literal.Len() > 0 {
			segments = append(segments, textSegment{Literal: literal.String()})
			literal.Reset()
		}
	}

	for i := 0; i < len(text); i++ {
		switch text[i] {
		case '\r':
			flush()
			segments = append(segments, textSegment{Key: "return"})
			if i+1 < len(text) && text[i+1] == '\n' {
				i++ // collapse CRLF into the single Return already emitted
			}
		case '\n':
			flush()
			segments = append(segments, textSegment{Key: "return"})
		case '\t':
			flush()
			segments = append(segments, textSegment{Key: "tab"})
		default:
			literal.WriteByte(text[i])
		}
	}
	flush()
	return segments
}

// chunkUTF16 encodes s as UTF-16 and splits it into chunks of at most maxUnits
// code units, never splitting a surrogate pair across a chunk boundary. macOS
// CGEventKeyboardSetUnicodeString takes a UniChar buffer, and a pair split
// across two events would be delivered as two replacement characters.
//
// A single code point that needs more units than maxUnits is emitted whole, so a
// chunk may be one unit over the cap rather than corrupt.
func chunkUTF16(s string, maxUnits int) [][]uint16 {
	if s == "" {
		return nil
	}
	if maxUnits < 1 {
		maxUnits = 1
	}

	var (
		chunks  [][]uint16
		current []uint16
	)
	for _, r := range s {
		units := utf16.Encode([]rune{r})
		if len(current) > 0 && len(current)+len(units) > maxUnits {
			chunks = append(chunks, current)
			current = nil
		}
		current = append(current, units...)
	}
	if len(current) > 0 {
		chunks = append(chunks, current)
	}
	return chunks
}

// charToKeyPress maps a single character to the US-layout key press that
// produces it, for handlers with no Unicode injection primitive. ok is false for
// anything outside printable ASCII — those characters cannot be expressed as a
// US-layout key press at all and the caller must report them rather than drop
// them silently.
func charToKeyPress(ch rune) (key string, modifiers []string, ok bool) {
	if ch >= 'A' && ch <= 'Z' {
		return string(ch + ('a' - 'A')), []string{"shift"}, true
	}
	if base, found := shiftedToBase[ch]; found {
		return base, []string{"shift"}, true
	}
	if ch >= ' ' && ch <= '~' {
		return string(ch), nil, true
	}
	return "", nil, false
}

// InjectText delivers text to the remote machine as literal characters,
// preferring the most faithful primitive the handler offers:
//
//  1. TextTyper     — one Unicode string per literal run (macOS, Windows).
//  2. TypeCharHandler — one Unicode character at a time.
//  3. SendKeyPress  — US-layout key synthesis (Linux/XTEST, which has no
//     Unicode injection primitive).
//
// Newlines and tabs are always real key presses so pasted shell blocks execute.
//
// On the key-synthesis fallback, characters outside printable ASCII have no
// US-layout key press; they are skipped and COUNTED in the returned error so
// the operator is told the paste is incomplete instead of it quietly differing
// from the clipboard. Only the count is reported, never the characters
// themselves — a paste can carry a password, and this error reaches the agent's
// log.
func InjectText(handler InputHandler, text string) error {
	if handler == nil {
		return fmt.Errorf("no input handler available")
	}
	if text == "" {
		return nil
	}

	textTyper, canTypeText := handler.(TextTyper)
	charTyper, canTypeChar := handler.(TypeCharHandler)

	skipped := 0
	for _, segment := range splitTextSegments(text) {
		if segment.Key != "" {
			if err := handler.SendKeyPress(segment.Key, nil); err != nil {
				return fmt.Errorf("failed to press %q while injecting text: %w", segment.Key, err)
			}
			continue
		}

		switch {
		case canTypeText:
			if err := textTyper.TypeText(segment.Literal); err != nil {
				return fmt.Errorf("failed to inject text: %w", err)
			}
		case canTypeChar:
			for _, ch := range segment.Literal {
				if err := charTyper.TypeChar(ch); err != nil {
					// The failing character is never named: it is clipboard
					// content, and this error reaches the agent's log.
					return fmt.Errorf("failed to inject text: %w", err)
				}
			}
		default:
			for _, ch := range segment.Literal {
				key, modifiers, ok := charToKeyPress(ch)
				if !ok {
					skipped++
					continue
				}
				if err := handler.SendKeyPress(key, modifiers); err != nil {
					return fmt.Errorf("failed to inject text: %w", err)
				}
			}
		}
	}

	if skipped > 0 {
		return fmt.Errorf("skipped %d character(s) with no key mapping on this platform", skipped)
	}
	return nil
}
