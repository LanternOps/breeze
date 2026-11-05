package backup

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// A torn tail (#11108). A short write on a full disk or a power loss can leave
// the journal's last line partial, and everything before it is still good, so
// losing the whole journal to it would throw away a resume's worth of uploads.
// The last line is torn when it is unterminated or does not parse. Only one line
// can be: a malformed line with another line after it is not explained by an
// interrupted append, and stays corruption.
//
// The torn line is ignored, which loses only what it would have added: an entry
// not recorded is uploaded again, and a header update not recorded costs what any
// failed journal write costs (see Record, publishControlObject).
//
// Verification records do not get off so lightly. The torn line may be the very
// retraction that was to precede an upload over an object, and a writer whose
// flush failed loses every line it tries after that, so a record older than a tear
// may vouch for an object that has since changed. All of them are dropped, while
// the entries stay: the cost is one more check pass, which continues across jobs
// like any other. Removing the fragment would remove the only sign of this, so
// the repair leaves a line that says it (see repairJournalTail).
//
// The format does not change. A repaired journal is whole lines of the kinds every
// reader since journalFormatVersion 2 knows.

// noTornTail is journalRead.tornAt for a journal with no torn last line.
const noTornTail int64 = -1

// journalLines splits a journal into lines like bufio.ScanLines, and also knows
// where the current line starts and whether a newline ended it, which ScanLines
// hides.
type journalLines struct {
	start, next int64
	terminated  bool
}

func (l *journalLines) split(data []byte, atEOF bool) (int, []byte, error) {
	advance, token, err := bufio.ScanLines(data, atEOF)
	if advance > 0 {
		l.start = l.next
		l.next += int64(advance)
		l.terminated = data[advance-1] == '\n'
	}
	return advance, token, err
}

// journalTailRepairFn is a test seam over repairJournalTail so a repair that fails
// can be exercised regardless of process privilege or free disk space.
var journalTailRepairFn = repairJournalTail

// setJournalTailRepairFnForTest overrides journalTailRepairFn. Call the returned
// restore func (typically via defer) to put the real repair back.
func setJournalTailRepairFnForTest(fn func(string, int64, journalHeader) error) (restore func()) {
	old := journalTailRepairFn
	journalTailRepairFn = fn
	return func() { journalTailRepairFn = old }
}

// repairJournalTail replaces the torn tail starting at byte offset at with a header
// update that lacks VerificationAware, which makes every later reader drop the
// records before it (see readJournal), so the drop holds after the fragment is gone.
//
// It overwrites in place and truncates afterwards, rather than truncating and then
// appending, so no moment leaves a clean-looking journal with its stale records in
// force. If it stops part way the journal still ends in a line that is torn, or in
// the update and what is left of the fragment, and the next open repairs it again.
func repairJournalTail(path string, at int64, header journalHeader) error {
	header.VerificationAware = false
	line, err := json.Marshal(journalHeaderUpdate{HeaderUpdate: header})
	if err != nil {
		return fmt.Errorf("failed to encode backup journal repair: %w", err)
	}
	line = append(line, '\n')
	// Not O_APPEND: WriteAt refuses it, and on Windows such a handle cannot truncate.
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	_, writeErr := f.WriteAt(line, at)
	if writeErr != nil {
		return errors.Join(writeErr, f.Close())
	}
	if err := f.Truncate(at + int64(len(line))); err != nil {
		return errors.Join(err, f.Close())
	}
	return f.Close()
}
