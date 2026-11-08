package main

// console-auth.js (password scrypt N=16384 r=8 p=1, client keys) + ops-tools.js + run-mode-file.js.
import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"hash"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// ---------------- scrypt (RFC 7914) ----------------
func pbkdf2SHA256(pw, salt []byte, iter, keyLen int) []byte {
	prf := hmac.New(sha256.New, pw)
	hLen := prf.Size()
	n := (keyLen + hLen - 1) / hLen
	var out []byte
	buf := make([]byte, 4)
	for b := 1; b <= n; b++ {
		prf.Reset()
		prf.Write(salt)
		binary.BigEndian.PutUint32(buf, uint32(b))
		prf.Write(buf)
		u := prf.Sum(nil)
		t := append([]byte(nil), u...)
		for i := 1; i < iter; i++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for j := range t {
				t[j] ^= u[j]
			}
		}
		out = append(out, t...)
	}
	return out[:keyLen]
}

var _ hash.Hash

func salsa208(b *[16]uint32) {
	x := *b
	for i := 0; i < 8; i += 2 {
		r := func(a, b uint32, n uint) uint32 { return (a+b)<<n | (a+b)>>(32-n) }
		x[4] ^= r(x[0], x[12], 7)
		x[8] ^= r(x[4], x[0], 9)
		x[12] ^= r(x[8], x[4], 13)
		x[0] ^= r(x[12], x[8], 18)
		x[9] ^= r(x[5], x[1], 7)
		x[13] ^= r(x[9], x[5], 9)
		x[1] ^= r(x[13], x[9], 13)
		x[5] ^= r(x[1], x[13], 18)
		x[14] ^= r(x[10], x[6], 7)
		x[2] ^= r(x[14], x[10], 9)
		x[6] ^= r(x[2], x[14], 13)
		x[10] ^= r(x[6], x[2], 18)
		x[3] ^= r(x[15], x[11], 7)
		x[7] ^= r(x[3], x[15], 9)
		x[11] ^= r(x[7], x[3], 13)
		x[15] ^= r(x[11], x[7], 18)
		x[1] ^= r(x[0], x[3], 7)
		x[2] ^= r(x[1], x[0], 9)
		x[3] ^= r(x[2], x[1], 13)
		x[0] ^= r(x[3], x[2], 18)
		x[6] ^= r(x[5], x[4], 7)
		x[7] ^= r(x[6], x[5], 9)
		x[4] ^= r(x[7], x[6], 13)
		x[5] ^= r(x[4], x[7], 18)
		x[11] ^= r(x[10], x[9], 7)
		x[8] ^= r(x[11], x[10], 9)
		x[9] ^= r(x[8], x[11], 13)
		x[10] ^= r(x[9], x[8], 18)
		x[12] ^= r(x[15], x[14], 7)
		x[13] ^= r(x[12], x[15], 9)
		x[14] ^= r(x[13], x[12], 13)
		x[15] ^= r(x[14], x[13], 18)
	}
	for i := range b {
		b[i] += x[i]
	}
}

func blockMix(b []uint32, y []uint32, r int) {
	var x [16]uint32
	copy(x[:], b[(2*r-1)*16:])
	for i := 0; i < 2*r; i++ {
		for j := 0; j < 16; j++ {
			x[j] ^= b[i*16+j]
		}
		salsa208(&x)
		copy(y[i*16:], x[:])
	}
	for i := 0; i < r; i++ {
		copy(b[i*16:], y[(2*i)*16:(2*i+1)*16])
		copy(b[(i+r)*16:], y[(2*i+1)*16:(2*i+2)*16])
	}
}

func scryptKey(pw, salt []byte, N, r, p, keyLen int) []byte {
	B := pbkdf2SHA256(pw, salt, 1, p*128*r)
	words := 32 * r
	xb := make([]uint32, words)
	y := make([]uint32, words)
	v := make([]uint32, N*words)
	for i := 0; i < p; i++ {
		blk := B[i*128*r : (i+1)*128*r]
		for j := range xb {
			xb[j] = binary.LittleEndian.Uint32(blk[j*4:])
		}
		for n := 0; n < N; n++ {
			copy(v[n*words:], xb)
			blockMix(xb, y, r)
		}
		for n := 0; n < N; n++ {
			jj := int(xb[(2*r-1)*16] & uint32(N-1))
			for k := range xb {
				xb[k] ^= v[jj*words+k]
			}
			blockMix(xb, y, r)
		}
		for j := range xb {
			binary.LittleEndian.PutUint32(blk[j*4:], xb[j])
		}
	}
	return pbkdf2SHA256(pw, B, 1, keyLen)
}

func pwHash(password, salt string) string {
	return hex.EncodeToString(scryptKey([]byte(password), []byte(salt), 16384, 8, 1, 32))
}
func safeEq(a, b string) bool { return len(a) == len(b) && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// ---------------- console auth ----------------
type ConsoleAuth struct {
	mu          sync.Mutex
	file        string
	internalKey string
	state       *Obj
}

var reHex32 = regexp.MustCompile(`^[0-9a-f]{32}$`)
var reHex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func NewConsoleAuth(file, internalKey string) (*ConsoleAuth, error) {
	if len(internalKey) < 16 {
		return nil, errors.New("Internal key required")
	}
	c := &ConsoleAuth{file: file, internalKey: internalKey, state: NewObj().Set("password", nil).Set("keys", []any{}).Set("internalExternal", true)}
	raw, err := readJSONFile(file)
	if err != nil {
		if os.IsNotExist(err) {
			return c, nil
		}
		return nil, errors.New("console-auth.json unreadable")
	}
	if d := asObj(raw); d != nil {
		if p := d.Obj("password"); p != nil && reHex32.MatchString(p.Str("salt")) && reHex64.MatchString(p.Str("hash")) {
			ua := p.V("updatedAt")
			if !truthy(ua) {
				ua = nil
			}
			c.state.Set("password", NewObj().Set("salt", p.Str("salt")).Set("hash", p.Str("hash")).Set("updatedAt", ua))
		}
		keys := []any{}
		for _, k := range d.Arr("keys") {
			ko := asObj(k)
			if ks, ok := ko.V("key").(string); ok && len(ks) >= 24 {
				if _, ok := ko.V("id").(string); ok {
					keys = append(keys, ko)
				}
			}
		}
		c.state.Set("keys", keys).Set("internalExternal", d.V("internalExternal") != false)
	}
	return c, nil
}
func (c *ConsoleAuth) save() error { return writeSimple(c.file, MarshalJSIndent(c.state, " "), 0600) }
func (c *ConsoleAuth) IsInternal(k string) bool { return k != "" && safeEq(k, c.internalKey) }
func (c *ConsoleAuth) Allows(k string, external bool) bool {
	if k == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.IsInternal(k) {
		return !external || c.state.V("internalExternal") != false
	}
	for _, x := range c.state.Arr("keys") {
		xo := asObj(x)
		if !truthy(xo.V("disabled")) && safeEq(xo.Str("key"), k) {
			return true
		}
	}
	return false
}
func (c *ConsoleAuth) verifyL(secret string) bool {
	if secret == "" || len(secret) > 512 {
		return false
	}
	if p := c.state.Obj("password"); p != nil {
		return safeEq(pwHash(secret, p.Str("salt")), p.Str("hash"))
	}
	return c.IsInternal(secret)
}
func (c *ConsoleAuth) VerifyLogin(secret any) bool {
	s, _ := secret.(string)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.verifyL(s)
}
func mask(k string) string {
	if len(k) < 10 {
		return k
	}
	return k[:6] + "…" + k[len(k)-4:]
}
func (c *ConsoleAuth) statusL() *Obj {
	p := c.state.Obj("password")
	var ua any
	if p != nil {
		ua = p.V("updatedAt")
	}
	keys := []any{}
	for _, x := range c.state.Arr("keys") {
		xo := asObj(x)
		keys = append(keys, NewObj().Set("id", xo.V("id")).Set("name", xo.V("name")).Set("masked", mask(xo.Str("key"))).Set("createdAt", xo.V("createdAt")).Set("disabled", truthy(xo.V("disabled"))))
	}
	return NewObj().Set("passwordSet", p != nil).Set("passwordUpdatedAt", ua).Set("internalExternal", c.state.V("internalExternal") != false).
		Set("internalMasked", mask(c.internalKey)).Set("keys", keys)
}
func (c *ConsoleAuth) Status() *Obj { c.mu.Lock(); defer c.mu.Unlock(); return c.statusL() }
func (c *ConsoleAuth) SetPassword(cur, next any) (*Obj, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	cs, _ := cur.(string)
	if !c.verifyL(cs) {
		return nil, herr(403, "当前密码不正确")
	}
	ns, ok := next.(string)
	if !ok || jsLen(ns) < 8 || jsLen(ns) > 128 {
		return nil, herr(400, "新密码长度需为 8–128 位")
	}
	salt := randHexN(16)
	c.state.Set("password", NewObj().Set("salt", salt).Set("hash", pwHash(ns, salt)).Set("updatedAt", nowMs()))
	return c.statusL(), c.save()
}
func (c *ConsoleAuth) CreateKey(name any) (*Obj, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	keys := c.state.Arr("keys")
	if len(keys) >= 50 {
		return nil, herr(400, "Key 数量已达上限")
	}
	label := clipRunes(strings.TrimSpace(jsStr(name)), 40)
	if label == "" {
		label = "未命名"
	}
	b := make([]byte, 24)
	rand.Read(b)
	key := "sk-ais-" + base64.RawURLEncoding.EncodeToString(b)
	item := NewObj().Set("id", uuid4()).Set("name", label).Set("key", key).Set("createdAt", nowMs())
	c.state.Set("keys", append(keys, item))
	if err := c.save(); err != nil {
		return nil, err
	}
	return c.statusL().Set("created", NewObj().Set("id", item.V("id")).Set("name", label).Set("key", key)), nil
}
func (c *ConsoleAuth) UpdateKey(id string, disabled any, remove bool) (*Obj, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	keys := c.state.Arr("keys")
	for i, x := range keys {
		xo := asObj(x)
		if xo.Str("id") != id {
			continue
		}
		if remove {
			c.state.Set("keys", append(append([]any{}, keys[:i]...), keys[i+1:]...))
		} else {
			xo.Set("disabled", truthy(disabled))
		}
		return c.statusL(), c.save()
	}
	return nil, herr(404, "Key 不存在")
}
func (c *ConsoleAuth) SetInternalExternal(on bool) (*Obj, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !on {
		any := false
		for _, x := range c.state.Arr("keys") {
			any = any || !truthy(asObj(x).V("disabled"))
		}
		if !any {
			return nil, herr(400, "请先创建至少一个可用的客户端 Key")
		}
	}
	c.state.Set("internalExternal", on)
	return c.statusL(), c.save()
}

// ---------------- stream mode (stream-mode.json; default fake, same file as browser mode) ----------------
type StreamMode struct {
	mu   sync.Mutex
	file string
	mode string
}

func NewStreamMode(file string) *StreamMode {
	s := &StreamMode{file: file, mode: "real"}
	if raw, err := readJSONFile(file); err == nil {
		if m := asObj(raw).Str("mode"); m == "real" || m == "fake" {
			s.mode = m
		}
	}
	return s
}
func (s *StreamMode) Get() string { s.mu.Lock(); defer s.mu.Unlock(); return s.mode }
func (s *StreamMode) Set(m string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := writeSimple(s.file, MarshalJS(NewObj().Set("mode", m).Set("updatedAt", nowMs())), 0600); err != nil {
		return err
	}
	s.mode = m
	return nil
}

// ---------------- run-mode.json ----------------
var runModes = []any{"headless", "dual", "single"}

func runModeRead(root string) *Obj {
	m := NewObj()
	if raw, err := readJSONFile(filepath.Join(root, "run-mode.json")); err == nil && asObj(raw) != nil {
		m = asObj(raw)
	}
	mode := m.Str("mode")
	if !inStrs(mode, "headless", "dual", "single") {
		mode = "headless"
	}
	var parked any
	if inStrs(m.Str("parked"), "A", "B") {
		parked = m.Str("parked")
	}
	return NewObj().Set("mode", mode).Set("single", m.V("single") == true).Set("parked", parked)
}
func runModeWrite(root, mode string) (*Obj, error) {
	if !inStrs(mode, "headless", "dual", "single") {
		return nil, herr(400, "运行模式只能是 headless、dual 或 single")
	}
	cur := runModeRead(root)
	var parked any
	if mode == "single" {
		parked = cur.V("parked")
		if parked == nil {
			parked = "B"
		}
	}
	next := NewObj().Set("mode", mode).Set("single", mode == "single").Set("parked", parked)
	return next, writeSimple(filepath.Join(root, "run-mode.json"), MarshalJS(next), 0600)
}
func scheduleCoordinatorRestart(unit string) {
	exec.Command("systemd-run", "--on-active=2", "--unit="+unit+strconv.FormatInt(nowMs(), 10), "/bin/systemctl", "restart", "ais2api-dual-coordinator.service").Start()
}

// ---------------- ops tools ----------------
var opsUnits = map[string]string{"headless": "ais2api-headless", "coordinator": "ais2api-dual-coordinator", "login": "ais2api-login"}
var opsUnitNames = map[string]string{"headless": "无浏览器服务", "coordinator": "调度器", "login": "登录服务"}
var opsUnitOrder = []string{"headless", "coordinator", "login"}
var opsContainers = []string{"ais2api-dual-a", "ais2api-dual-b", "ais2api-dual-management"}

// opsMerged: management backend (8893) and login service (8894) run in the Rust process (/opt/ais2api/coord-rs/MERGED);
// with the Go coordinator a Rust side process started by launch.sh serves them inside the coordinator unit.
func opsMerged() bool {
	_, err := os.Stat("/opt/ais2api/coord-rs/MERGED")
	return err == nil
}
func opsUnitOf(key string) string {
	if key == "login" && opsMerged() {
		return opsUnits["coordinator"]
	}
	return opsUnits[key]
}

// coordinator log lines that belong to the login service when merged
var reLoginLog = regexp.MustCompile(`^\[(Login|Relogin|NightlyRelogin|Import|CookieSync|Management)\]|^login service`)

func run(timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return string(out), err
}

var reCredURL = regexp.MustCompile(`(\w+://)[^\s:@/]+:[^\s@/]+@`)
var reBearer = regexp.MustCompile(`(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}`)
var reSk = regexp.MustCompile(`\b(sk-|AIza)[A-Za-z0-9_-]{8,}`)
var reLongHex = regexp.MustCompile(`(?i)\b[a-f0-9]{40,}\b`)

func maskLog(s string) string {
	s = reCredURL.ReplaceAllString(s, "${1}***@")
	s = reBearer.ReplaceAllString(s, "${1}***")
	s = reSk.ReplaceAllString(s, "${1}***")
	return reLongHex.ReplaceAllStringFunc(s, func(m string) string { return m[:6] + "…" })
}

func memInfo() *Obj {
	b, _ := os.ReadFile("/proc/meminfo")
	g := func(k string) int64 {
		m := regexp.MustCompile(`(?m)^` + k + `:\s+(\d+)`).FindStringSubmatch(string(b))
		if m == nil {
			return 0
		}
		n, _ := strconv.ParseInt(m[1], 10, 64)
		return n * 1024
	}
	return NewObj().Set("total", g("MemTotal")).Set("available", g("MemAvailable")).Set("swapTotal", g("SwapTotal")).Set("swapFree", g("SwapFree"))
}

func opsUnit(key string) *Obj {
	out, _ := run(15*time.Second, "systemctl", "show", opsUnits[key], "-p", "ActiveState", "-p", "SubState", "-p", "MemoryCurrent", "-p", "ActiveEnterTimestamp", "-p", "NRestarts", "-p", "MemoryMax", "-p", "ControlGroup")
	kv := map[string]string{}
	for _, l := range strings.Split(out, "\n") {
		if i := strings.Index(l, "="); i > 0 {
			kv[l[:i]] = l[i+1:]
		}
	}
	num := func(v string) any {
		if reDigits.MatchString(v) {
			n, _ := strconv.ParseInt(v, 10, 64)
			return n
		}
		return nil
	}
	var since any
	if ts := kv["ActiveEnterTimestamp"]; ts != "" {
		if t, err := time.Parse("Mon 2006-01-02 15:04:05 MST", ts); err == nil {
			since = t.UnixMilli()
		}
	}
	st := kv["ActiveState"]
	if st == "" {
		st = "unknown"
	}
	// MemoryCurrent includes page cache charged by child commands (docker CLI, journalctl, git) and is reclaimed on
	// demand; show the non-reclaimable part and report the cache separately
	var cache any
	if g := kv["ControlGroup"]; strings.HasPrefix(g, "/") && !strings.Contains(g, "..") {
		if b, err := os.ReadFile("/sys/fs/cgroup" + g + "/memory.stat"); err == nil {
			for _, l := range strings.Split(string(b), "\n") {
				if v, ok := strings.CutPrefix(l, "file "); ok {
					if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil {
						cache = n
					}
					break
				}
			}
		}
	}
	mem := num(kv["MemoryCurrent"])
	if c, ok := mem.(int64); ok {
		if f, ok := cache.(int64); ok {
			mem = max(c-f, 0)
		}
	}
	name := opsUnitNames[key]
	if key == "coordinator" && opsMerged() {
		name = "调度器（含管理后台、登录服务）"
	}
	return NewObj().Set("key", key).Set("unit", opsUnits[key]).Set("name", name).Set("state", st).Set("sub", kv["SubState"]).
		Set("memory", mem).Set("memoryCache", cache).Set("memoryMax", num(kv["MemoryMax"])).Set("since", since).Set("restarts", num(kv["NRestarts"]))
}

func opsOverview(cwd string) *Obj {
	units := []any{}
	merged := opsMerged()
	for _, k := range opsUnitOrder {
		if merged && k == "login" {
			continue
		}
		units = append(units, opsUnit(k))
	}
	out, _ := run(15*time.Second, "docker", "ps", "-a", "--format", "{{.Names}}\t{{.State}}\t{{.Status}}")
	rows := map[string]*Obj{}
	for _, l := range strings.Split(out, "\n") {
		if p := strings.Split(l, "\t"); len(p) == 3 {
			rows[p[0]] = NewObj().Set("name", p[0]).Set("state", p[1]).Set("status", p[2])
		}
	}
	ctr := []any{}
	for _, n := range opsContainers {
		if merged && n == "ais2api-dual-management" {
			continue
		}
		if r := rows[n]; r != nil {
			ctr = append(ctr, r)
		} else {
			ctr = append(ctr, NewObj().Set("name", n).Set("state", "missing").Set("status", ""))
		}
	}
	vo, _ := run(15*time.Second, "git", "-C", cwd, "log", "-1", "--format=%h%x09%ct%x09%s")
	vp := strings.SplitN(strings.TrimSpace(vo), "\t", 3)
	ver := NewObj().Set("hash", nil).Set("at", nil).Set("subject", "")
	if len(vp) == 3 {
		at, _ := strconv.ParseInt(vp[1], 10, 64)
		ver.Set("hash", vp[0]).Set("at", at*1000).Set("subject", vp[2])
	}
	dout, _ := run(15*time.Second, "git", "-C", cwd, "status", "--porcelain")
	dirty := 0
	for _, l := range strings.Split(dout, "\n") {
		if l != "" && !strings.HasPrefix(l, "??") {
			dirty++
		}
	}
	ver.Set("dirty", dirty)
	var load [3]float64
	if b, err := os.ReadFile("/proc/loadavg"); err == nil {
		f := strings.Fields(string(b))
		for i := 0; i < 3 && i < len(f); i++ {
			load[i], _ = strconv.ParseFloat(f[i], 64)
		}
	}
	var uptime float64
	if b, err := os.ReadFile("/proc/uptime"); err == nil {
		uptime, _ = strconv.ParseFloat(strings.Fields(string(b))[0], 64)
	}
	host, _ := os.Hostname()
	var dk any
	var sf syscall.Statfs_t
	if syscall.Statfs("/", &sf) == nil {
		dk = NewObj().Set("total", int64(sf.Blocks)*sf.Bsize).Set("free", int64(sf.Bavail)*sf.Bsize)
	}
	cpus := 0
	if b, err := os.ReadFile("/proc/cpuinfo"); err == nil {
		cpus = strings.Count(string(b), "\nprocessor") + 1
	}
	return NewObj().Set("at", nowMs()).Set("host", NewObj().Set("hostname", host).Set("uptime", uptime).Set("load", []any{load[0], load[1], load[2]}).
		Set("cpus", cpus).Set("memory", memInfo()).Set("disk", dk)).Set("units", units).Set("containers", ctr).Set("version", ver)
}

func opsLogs(source string, n int) ([]any, error) {
	if n < 20 {
		n = 200
	}
	if n > 1000 {
		n = 1000
	}
	out := []any{}
	if source == "headless" {
		f, err := os.Open("/opt/as2a-nb/run.log")
		if err != nil {
			return out, nil
		}
		defer f.Close()
		st, _ := f.Stat()
		ln := int64(n * 600)
		if ln > st.Size() {
			ln = st.Size()
		}
		buf := make([]byte, ln)
		f.ReadAt(buf, st.Size()-ln)
		lines := strings.Split(string(buf), "\n")
		var nz []string
		for _, l := range lines {
			if l != "" {
				nz = append(nz, l)
			}
		}
		if len(nz) > 0 {
			nz = nz[1:]
		}
		if len(nz) > n {
			nz = nz[len(nz)-n:]
		}
		for _, l := range nz {
			j, err := ParseObj([]byte(l))
			if err != nil {
				out = append(out, NewObj().Set("t", nil).Set("level", "info").Set("source", "").Set("msg", maskLog(l)))
				continue
			}
			msg := j.Str("msg")
			if rq := j.Obj("request"); rq != nil {
				st := rq.V("status")
				if st == nil {
					st = rq.V("state")
				}
				msg = rq.Str("method") + " " + rq.Str("path") + " " + jsStr(st)
				if d, ok := asNum(rq.V("duration_ms")); ok {
					msg += " " + strconv.FormatInt(int64(d+0.5), 10) + "ms"
				}
				if e := jsStr(rq.V("error")); e != "" {
					msg += " " + e
				}
			}
			var t any
			if tt, err := time.Parse(time.RFC3339Nano, j.Str("time")); err == nil {
				t = tt.UnixMilli()
			}
			lv := strings.ToLower(j.Str("level"))
			if lv == "" {
				lv = "info"
			}
			out = append(out, NewObj().Set("t", t).Set("level", lv).Set("source", j.Str("source")).Set("msg", maskLog(msg)))
		}
		return out, nil
	}
	u := opsUnitOf(source)
	if u == "" {
		return nil, herr(400, "未知日志来源")
	}
	onlyLogin := source == "login" && opsMerged()
	fetch := n
	if onlyLogin {
		fetch = min(n*20, 20000)
	}
	text, _ := run(15*time.Second, "journalctl", "-u", u, "-n", strconv.Itoa(fetch), "--no-pager", "-o", "json", "--output-fields=MESSAGE,PRIORITY,__REALTIME_TIMESTAMP")
	reErr := regexp.MustCompile(`(?i)error|failed|失败`)
	reWarn := regexp.MustCompile(`(?i)\bwarn|gave up|cooldown`)
	for _, l := range strings.Split(text, "\n") {
		j, err := ParseObj([]byte(l))
		if err != nil {
			continue
		}
		var msg string
		if a := j.Arr("MESSAGE"); a != nil {
			b := make([]byte, len(a))
			for i, x := range a {
				f, _ := asNum(x)
				b[i] = byte(f)
			}
			msg = string(b)
		} else {
			msg = jsStr(j.V("MESSAGE"))
		}
		if onlyLogin && !reLoginLog.MatchString(msg) {
			continue
		}
		p, _ := strconv.Atoi(jsStr(j.V("PRIORITY")))
		lv := "info"
		if p <= 3 && j.V("PRIORITY") != nil || reErr.MatchString(msg) {
			lv = "error"
		} else if p == 4 || reWarn.MatchString(msg) {
			lv = "warn"
		}
		ts, _ := strconv.ParseInt(jsStr(j.V("__REALTIME_TIMESTAMP")), 10, 64)
		var t any
		if ts > 0 {
			t = (ts + 500) / 1000
		}
		out = append(out, NewObj().Set("t", t).Set("level", lv).Set("source", "").Set("msg", maskLog(msg)))
	}
	return out, nil
}

func opsRestartUnit(key string) (*Obj, error) {
	u := opsUnitOf(key)
	if u == "" {
		return nil, herr(400, "未知服务")
	}
	if key == "login" && opsMerged() {
		key = "coordinator"
	}
	if key == "coordinator" {
		exec.Command("systemd-run", "--on-active=2", "--unit=ais2api-ops-restart-"+strconv.FormatInt(nowMs(), 10), "/bin/systemctl", "restart", u).Start()
		return NewObj().Set("scheduled", true), nil
	}
	if _, err := run(60*time.Second, "systemctl", "restart", u); err != nil {
		return nil, herr(409, "重启失败："+clipRunes(err.Error(), 200))
	}
	return NewObj().Set("restarted", true), nil
}

const backupDir = "/root/auth-backup"

var reBackup = regexp.MustCompile(`^auth-\d{8}-\d{4,6}\.tgz$`)

func opsBackups() []any {
	ents, _ := os.ReadDir(backupDir)
	var names []string
	for _, e := range ents {
		if reBackup.MatchString(e.Name()) {
			names = append(names, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	out := []any{}
	for i, n := range names {
		if i >= 20 {
			break
		}
		st, err := os.Stat(filepath.Join(backupDir, n))
		if err == nil {
			out = append(out, NewObj().Set("name", n).Set("size", st.Size()).Set("at", st.ModTime().UnixMilli()))
		}
	}
	return out
}
func opsBackup() (*Obj, error) {
	os.MkdirAll(backupDir, 0700)
	d := time.Now().UTC().Add(8 * time.Hour)
	name := "auth-" + d.Format("20060102") + "-" + d.Format("150405") + ".tgz"
	if _, err := run(60*time.Second, "tar", "czf", filepath.Join(backupDir, name), "-C", "/opt/ais2api", "auth", "-C", "/opt/as2a-nb", "auth", "import-state.json"); err != nil {
		return nil, herr(409, "备份失败："+clipRunes(err.Error(), 160))
	}
	os.Chmod(filepath.Join(backupDir, name), 0600)
	ents, _ := os.ReadDir(backupDir)
	var all []string
	for _, e := range ents {
		if reBackup.MatchString(e.Name()) {
			all = append(all, e.Name())
		}
	}
	sort.Strings(all)
	for i := 0; i < len(all)-20; i++ {
		os.Remove(filepath.Join(backupDir, all[i]))
	}
	return NewObj().Set("name", name).Set("backups", opsBackups()), nil
}