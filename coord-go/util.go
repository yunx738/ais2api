package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const DAY = int64(86400000)
const RESET_OFFSET = int64(7 * 3600000)

func nowMs() int64 { return time.Now().UnixMilli() }
func periodStart(t int64) int64 {
	q := (t - RESET_OFFSET) / DAY
	if (t-RESET_OFFSET)%DAY < 0 {
		q--
	}
	return q*DAY + RESET_OFFSET
}
func untilNextReset(now int64) int64 { return periodStart(now) + DAY - now }

// HTTPError carries a status code to the HTTP layer (JS: Object.assign(Error(m),{statusCode})).
type HTTPError struct {
	Status     int
	Msg        string
	RetryAfter int64
	Code       string
}

func (e *HTTPError) Error() string { return e.Msg }
func herr(status int, msg string) *HTTPError {
	return &HTTPError{Status: status, Msg: msg}
}
func statusOf(err error) int {
	if e, ok := err.(*HTTPError); ok {
		return e.Status
	}
	return 0
}
func inInts(x int, list ...int) bool {
	for _, v := range list {
		if v == x {
			return true
		}
	}
	return false
}
func inStrs(x string, list ...string) bool {
	for _, v := range list {
		if v == x {
			return true
		}
	}
	return false
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
func uuid4() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

var reUUID = regexp.MustCompile(`^[a-f0-9-]{36}$`)
var reUUIDStrict = regexp.MustCompile(`(?i)^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var reAPP = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var reCanonModel = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$`)

// writeAtomic: tmp file (O_EXCL) + optional fsync + rename (+ dir fsync).
func writeAtomic(file string, data []byte, mode os.FileMode, durable bool) error {
	tmp := file + "." + randHex(8) + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer os.Remove(tmp)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if durable {
		if err = f.Sync(); err != nil {
			f.Close()
			return err
		}
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp, file); err != nil {
		return err
	}
	if durable {
		if d, err := os.Open(filepath.Dir(file)); err == nil {
			d.Sync()
			d.Close()
		}
	}
	return nil
}

// writeSimple mirrors fs.writeFileSync(tmp)+renameSync (fixed .tmp name).
func writeSimple(file string, data []byte, mode os.FileMode) error {
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}

func readJSONFile(file string) (any, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	return ParseJSON(b)
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	// cut on a rune boundary
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// clipRunes approximates JS String#slice(0,n) (UTF-16 units ~ runes).
func clipRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	i := 0
	for p := range s {
		if i == n {
			return s[:p]
		}
		i++
	}
	return s
}
func jsLen(s string) int { // UTF-16 length
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func sortedInts(m map[int]bool) []int {
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}
func itoa(i int) string { return strconv.Itoa(i) }
func i64(v int64) string { return strconv.FormatInt(v, 10) }

// Beijing time "YYYY-MM-DD HH:MM" (JS: new Date(t+8h).toISOString().slice(0,16).replace('T',' ')).
func bjTime(ms int64) string {
	return time.UnixMilli(ms + 8*3600000).UTC().Format("2006-01-02 15:04")
}

func trimSpace(s string) string { return strings.TrimSpace(s) }

var logger = log.New(os.Stdout, "", 0)

func logf(format string, a ...any) { logger.Printf(format, a...) }
func errf(format string, a ...any) { log.New(os.Stderr, "", 0).Printf(format, a...) }

func must[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func ceilDiv(a, b int64) int64 {
	if b == 0 {
		return 0
	}
	q := a / b
	if a%b != 0 && (a > 0) == (b > 0) {
		q++
	}
	return q
}

func fmtErr(e any) string { return fmt.Sprint(e) }