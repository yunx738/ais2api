package main

// Login files (/opt/ais2api/auth/auth-<id>.json): account e-mail, tier, alias, cookie info.
// headless-import.js: keeps /opt/as2a-nb/auth/<email>/storage-state.json in step with the login files.
// account-schedule.json (new): per-account groups and priority for the dispatcher.
import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"
)

const AUTH_DIR = "/opt/ais2api/auth"

var TIERS = []string{"standard", "pro", "ultra", "ultra20"}
var reEmail = regexp.MustCompile(`^[^\s@]+@[^\s@]+$`)

type authCache struct {
	tag  string
	data *Obj
}

type Accounts struct {
	mu        sync.Mutex
	authDir   string
	modeFile  string
	cache     map[int]authCache
	mode      *Obj // ultra-mode.json {enabled,slot}
}

func NewAccounts(authDir, modeFile string) *Accounts {
	a := &Accounts{authDir: authDir, modeFile: modeFile, cache: map[int]authCache{}}
	a.mode = NewObj().Set("enabled", false).Set("slot", "B")
	if raw, err := readJSONFile(modeFile); err == nil {
		if m := asObj(raw); m != nil {
			slot := m.Str("slot")
			if !inStrs(slot, "A", "B") {
				slot = "B"
			}
			a.mode = NewObj().Set("enabled", m.V("enabled") == true).Set("slot", slot)
		}
	}
	return a
}

func (a *Accounts) file(id int) string { return filepath.Join(a.authDir, "auth-"+strconv.Itoa(id)+".json") }

func fileTag(st os.FileInfo) string {
	ino := uint64(0)
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		ino = s.Ino
	}
	return strconv.FormatUint(ino, 10) + ":" + strconv.FormatInt(st.Size(), 10) + ":" + strconv.FormatInt(st.ModTime().UnixNano(), 10)
}

// data returns the parsed login file (cached by inode/size/mtime) or nil.
func (a *Accounts) data(id int) *Obj {
	if id < 1 {
		return nil
	}
	st, err := os.Stat(a.file(id))
	if err != nil {
		return nil
	}
	tag := fileTag(st)
	a.mu.Lock()
	hit, ok := a.cache[id]
	a.mu.Unlock()
	if ok && hit.tag == tag {
		return hit.data
	}
	var d *Obj
	if raw, err := readJSONFile(a.file(id)); err == nil {
		d = asObj(raw)
	}
	a.mu.Lock()
	a.cache[id] = authCache{tag, d}
	a.mu.Unlock()
	return d
}

func (a *Accounts) Email(id int) string {
	d := a.data(id)
	for _, k := range []string{"accountName", "displayName"} {
		if s, ok := d.V(k).(string); ok && reEmail.MatchString(strings.TrimSpace(s)) {
			return strings.ToLower(strings.TrimSpace(s))
		}
	}
	return ""
}
func (a *Accounts) Tier(id int) string {
	t := a.data(id).Str("accountTier")
	if inStrs(t, TIERS...) {
		return t
	}
	return "standard"
}
func (a *Accounts) IsPremium(id int) bool { return a.Tier(id) != "standard" }
func (a *Accounts) IsUltra(id int) bool   { t := a.Tier(id); return t == "ultra" || t == "ultra20" }
func (a *Accounts) Names(id int) (alias, name string) {
	d := a.data(id)
	alias, _ = d.V("displayName").(string)
	name, _ = d.V("accountName").(string)
	return
}

var reCtl = regexp.MustCompile("[\u0000-\u001f\u007f]")

func (a *Accounts) update(id int, change func(*Obj)) error {
	f := a.file(id)
	st, err := os.Lstat(f)
	if err != nil {
		return herr(404, "账号 "+strconv.Itoa(id)+" 不存在")
	}
	if !st.Mode().IsRegular() {
		return herr(409, "认证文件类型异常")
	}
	raw, err := readJSONFile(f)
	d := asObj(raw)
	if err != nil || d == nil {
		return errors.New("auth file unreadable")
	}
	change(d)
	if err := writeAtomic(f, MarshalJS(d), st.Mode().Perm(), true); err != nil {
		return err
	}
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		os.Chown(f, int(s.Uid), int(s.Gid))
	}
	a.mu.Lock()
	delete(a.cache, id)
	a.mu.Unlock()
	return nil
}
func (a *Accounts) SetTier(id int, tier string) (*Obj, error) {
	if !inStrs(tier, TIERS...) {
		return nil, herr(400, "分类只能是 standard、pro、ultra 或 ultra20")
	}
	err := a.update(id, func(d *Obj) {
		if tier == "standard" {
			d.Del("accountTier")
		} else {
			d.Set("accountTier", tier)
		}
	})
	if err != nil {
		return nil, err
	}
	return NewObj().Set("id", id).Set("tier", tier), nil
}
func (a *Accounts) SetAlias(id int, name any) (*Obj, error) {
	if name != nil {
		if _, ok := name.(string); !ok {
			return nil, herr(400, "名称格式无效")
		}
	}
	s := strings.TrimSpace(reCtl.ReplaceAllString(jsStr(name), ""))
	if jsLen(s) > 40 {
		return nil, herr(400, "名称最多 40 个字")
	}
	err := a.update(id, func(d *Obj) {
		if s != "" {
			d.Set("displayName", s)
		} else {
			d.Del("displayName")
		}
	})
	if err != nil {
		return nil, err
	}
	return NewObj().Set("id", id).Set("alias", s), nil
}
func (a *Accounts) Status(ids []int) *Obj {
	var u, p, pr []any
	u, p, pr = []any{}, []any{}, []any{}
	for _, id := range ids {
		if a.IsUltra(id) {
			u = append(u, id)
		}
		if a.Tier(id) == "pro" {
			p = append(p, id)
		}
		if a.IsPremium(id) {
			pr = append(pr, id)
		}
	}
	a.mu.Lock()
	m := a.mode.Clone()
	a.mu.Unlock()
	return m.Set("active", false).Set("single", true).Set("ultraAccounts", u).Set("proAccounts", p).Set("premiumAccounts", pr)
}
func (a *Accounts) SetMode(b *Obj) error {
	en, ok := b.V("enabled").(bool)
	slot := a.mode.Str("slot")
	if v, has := b.Get("slot"); has && v != nil {
		slot, _ = v.(string)
	}
	if !ok || !inStrs(slot, "A", "B") {
		return herr(400, "参数无效")
	}
	m := NewObj().Set("enabled", en).Set("slot", slot)
	if err := writeSimple(a.modeFile, MarshalJS(m), 0600); err != nil {
		return err
	}
	a.mu.Lock()
	a.mode = m
	a.mu.Unlock()
	return nil
}

var keyCookies = map[string]bool{"SID": true, "__Secure-1PSID": true, "__Secure-3PSID": true}
var reGoogle = regexp.MustCompile(`(^|\.)google\.com$`)

// authFileInfo (auth-maintenance.js) for the status page.
func (a *Accounts) FileInfo(id int) *Obj {
	f := a.file(id)
	st, err := os.Lstat(f)
	if err != nil {
		if os.IsNotExist(err) {
			return NewObj().Set("state", "missing")
		}
		return NewObj().Set("state", "unreadable")
	}
	if !st.Mode().IsRegular() || st.Size() > 262144 {
		return NewObj().Set("state", "unreadable")
	}
	d := a.data(id)
	if d == nil || d.Arr("cookies") == nil || d.Arr("origins") == nil {
		return NewObj().Set("state", "unreadable")
	}
	o := NewObj().Set("state", "ok").Set("modifiedAt", st.ModTime().UnixMilli())
	n := 0
	var exp []int64
	for _, c := range d.Arr("cookies") {
		co := asObj(c)
		if co == nil || !keyCookies[co.Str("name")] || !reGoogle.MatchString(jsStr(co.V("domain"))) {
			continue
		}
		n++
		if e, ok := asNum(co.V("expires")); ok && e > 0 {
			exp = append(exp, int64(e*1000+0.5))
		}
	}
	o.Set("keyCookies", n)
	if n == 0 {
		return o.Set("expiresAt", nil).Set("session", false)
	}
	if len(exp) > 0 {
		mn := exp[0]
		for _, e := range exp {
			if e < mn {
				mn = e
			}
		}
		o.Set("expiresAt", mn)
	} else {
		o.Set("expiresAt", nil)
	}
	return o.Set("session", len(exp) < n)
}

// ---- headless import ----
type Importer struct {
	acc       *Accounts
	target    string
	stateFile string
	mu        sync.Mutex
}

func mtimeMs(st os.FileInfo) float64 { return float64(st.ModTime().UnixNano()) / 1e6 }

func (im *Importer) state() *Obj {
	if raw, err := readJSONFile(im.stateFile); err == nil {
		if o := asObj(raw); o != nil {
			if o.Obj("accounts") == nil {
				o.Set("accounts", NewObj())
			}
			return o
		}
	}
	return NewObj().Set("accounts", NewObj())
}
func (im *Importer) save(s *Obj) error { return writeAtomic(im.stateFile, MarshalJS(s), 0600, true) }

func (im *Importer) Has(id int) bool {
	e := im.acc.Email(id)
	return e != "" && fileExists(filepath.Join(im.target, e, "storage-state.json"))
}

type SyncResult struct{ Added, Changed []int }

func (im *Importer) Sync(ids []int) (SyncResult, *Obj) {
	im.mu.Lock()
	defer im.mu.Unlock()
	st := im.state()
	accs := st.Obj("accounts")
	out := SyncResult{}
	skipped := NewObj()
	os.MkdirAll(im.target, 0700)
	for _, id := range ids {
		file := im.acc.file(id)
		fst, err := os.Stat(file)
		if err != nil {
			skipped.Set(itoa(id), "no_auth_file")
			continue
		}
		email := im.acc.Email(id)
		if email == "" {
			skipped.Set(itoa(id), "no_email")
			continue
		}
		dir := filepath.Join(im.target, email)
		prev := accs.Obj(itoa(id))
		fresh := !fileExists(filepath.Join(dir, "storage-state.json"))
		pm, _ := asNum(prev.V("mtime"))
		if !fresh && prev != nil && prev.Str("email") == email && pm >= mtimeMs(fst) {
			continue
		}
		raw, err := readJSONFile(file)
		data := asObj(raw)
		if err != nil || data == nil {
			skipped.Set(itoa(id), "unreadable")
			continue
		}
		if len(data.Arr("cookies")) == 0 {
			skipped.Set(itoa(id), "no_cookies")
			continue
		}
		os.MkdirAll(dir, 0700)
		origins := data.Arr("origins")
		if origins == nil {
			origins = []any{}
		}
		storage := NewObj().Set("cookies", data.Arr("cookies")).Set("origins", origins).Set("accountName", email)
		if truthy(data.V("accountTier")) {
			storage.Set("accountTier", data.V("accountTier"))
		}
		writeAtomic(filepath.Join(dir, "storage-state.json"), MarshalJS(storage), 0600, true)
		cfgFile := filepath.Join(dir, "account.json")
		cfg := NewObj()
		if r, err := readJSONFile(cfgFile); err == nil && asObj(r) != nil {
			cfg = asObj(r)
		}
		var proxy any = ""
		if cfg.Has("proxy") {
			proxy = cfg.V("proxy")
		}
		next := NewObj().Set("label", email).Set("enabled", true).Set("proxy", proxy).Set("locale", "en-US").Set("timezone", "Europe/Berlin")
		if string(MarshalJS(next)) != string(MarshalJS(cfg)) {
			writeAtomic(cfgFile, MarshalJSIndent(next, " "), 0600, true)
		}
		accs.Set(itoa(id), NewObj().Set("email", email).Set("mtime", mtimeMs(fst)).Set("at", nowMs()))
		if fresh {
			out.Added = append(out.Added, id)
		} else {
			out.Changed = append(out.Changed, id)
		}
	}
	if len(out.Added) > 0 || len(out.Changed) > 0 {
		im.save(st)
	}
	return out, skipped
}

func (im *Importer) WriteBack(ids []int) *Obj {
	im.mu.Lock()
	defer im.mu.Unlock()
	st := im.state()
	accs := st.Obj("accounts")
	written := []any{}
	skipped := NewObj()
	for _, id := range ids {
		prev := accs.Obj(itoa(id))
		if prev == nil {
			continue
		}
		file := im.acc.file(id)
		src := filepath.Join(im.target, prev.Str("email"), "storage-state.json")
		ss, e1 := os.Stat(src)
		as, e2 := os.Stat(file)
		if e1 != nil || e2 != nil {
			continue
		}
		pat, _ := asNum(prev.V("at"))
		pm, _ := asNum(prev.V("mtime"))
		if mtimeMs(ss) <= pat+1000 || mtimeMs(as) > pm+1 {
			continue
		}
		r1, err1 := readJSONFile(src)
		r2, err2 := readJSONFile(file)
		state, auth := asObj(r1), asObj(r2)
		if err1 != nil || err2 != nil || state == nil || auth == nil {
			skipped.Set(itoa(id), "unreadable")
			continue
		}
		if len(state.Arr("cookies")) == 0 {
			skipped.Set(itoa(id), "no_cookies")
			continue
		}
		if string(MarshalJS(state.V("cookies"))) == string(MarshalJS(auth.V("cookies"))) {
			p := prev.Clone()
			p.Set("at", nowMs())
			accs.Set(itoa(id), p)
			continue
		}
		next := auth.Clone()
		next.Set("cookies", state.V("cookies"))
		if len(state.Arr("origins")) > 0 {
			next.Set("origins", state.V("origins"))
		}
		writeAtomic(file, MarshalJS(next), 0600, true)
		if s, ok := as.Sys().(*syscall.Stat_t); ok {
			os.Chown(file, int(s.Uid), int(s.Gid))
		}
		os.Chmod(file, 0600)
		ns, _ := os.Stat(file)
		p := prev.Clone()
		p.Set("mtime", mtimeMs(ns)).Set("at", nowMs())
		accs.Set(itoa(id), p)
		written = append(written, id)
	}
	im.save(st)
	return NewObj().Set("written", written).Set("skipped", skipped)
}

// ---- account-schedule.json: groups + priority (new; ignored by the Node version) ----
type SchedEntry struct {
	Groups   []string
	Priority int
}
type AccountSched struct {
	mu   sync.RWMutex
	file string
	m    map[int]SchedEntry
}

var reGroup = regexp.MustCompile(`^[\p{L}\p{N}_-]{1,20}$`)

func NewAccountSched(file string) *AccountSched {
	s := &AccountSched{file: file, m: map[int]SchedEntry{}}
	if raw, err := readJSONFile(file); err == nil {
		acc := asObj(raw).Obj("accounts")
		for _, k := range acc.Keys() {
			id, err := strconv.Atoi(k)
			e := acc.Obj(k)
			if err != nil || id < 1 || e == nil {
				continue
			}
			var se SchedEntry
			for _, g := range e.Arr("groups") {
				if gs, ok := g.(string); ok && reGroup.MatchString(gs) {
					se.Groups = append(se.Groups, gs)
				}
			}
			if p, ok := asSafeInt(e.V("priority")); ok && p >= -100 && p <= 100 {
				se.Priority = int(p)
			}
			s.m[id] = se
		}
	}
	return s
}
func (s *AccountSched) Get(id int) SchedEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.m[id]
}
func (s *AccountSched) Priority(id int) int { return s.Get(id).Priority }
func (s *AccountSched) InGroup(id int, g string) bool {
	for _, x := range s.Get(id).Groups {
		if x == g {
			return true
		}
	}
	return false
}
func (s *AccountSched) AllGroups() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	seen := map[string]bool{}
	var out []string
	for _, e := range s.m {
		for _, g := range e.Groups {
			if !seen[g] {
				seen[g] = true
				out = append(out, g)
			}
		}
	}
	sort.Strings(out)
	return out
}
func (s *AccountSched) Members(g string, ids []int) []int {
	var out []int
	for _, id := range ids {
		if s.InGroup(id, g) {
			out = append(out, id)
		}
	}
	return out
}
func (s *AccountSched) save() error {
	acc := NewObj()
	var ids []int
	for id := range s.m {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	for _, id := range ids {
		e := s.m[id]
		if len(e.Groups) == 0 && e.Priority == 0 {
			continue
		}
		gs := []any{}
		for _, g := range e.Groups {
			gs = append(gs, g)
		}
		acc.Set(itoa(id), NewObj().Set("groups", gs).Set("priority", e.Priority))
	}
	return writeAtomic(s.file, MarshalJSIndent(NewObj().Set("version", 1).Set("accounts", acc), " "), 0600, true)
}

// Set: groups (array of names or comma separated string) and/or priority (-100..100).
func (s *AccountSched) Set(id int, b *Obj) (*Obj, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.m[id]
	if v, ok := b.Get("groups"); ok {
		var list []string
		switch x := v.(type) {
		case string:
			for _, p := range strings.FieldsFunc(x, func(r rune) bool { return r == ',' || r == '，' || r == ' ' || r == '、' }) {
				list = append(list, p)
			}
		case []any:
			for _, p := range x {
				ps, ok := p.(string)
				if !ok {
					return nil, herr(400, "分组名称无效")
				}
				list = append(list, strings.TrimSpace(ps))
			}
		case nil:
		default:
			return nil, herr(400, "分组格式无效")
		}
		seen := map[string]bool{}
		var clean []string
		for _, g := range list {
			if g == "" || seen[g] {
				continue
			}
			if !reGroup.MatchString(g) || utf8.RuneCountInString(g) > 20 {
				return nil, herr(400, "分组名只能用文字、数字、_ 和 -，最长 20 个字："+clipRunes(g, 30))
			}
			seen[g] = true
			clean = append(clean, g)
		}
		if len(clean) > 10 {
			return nil, herr(400, "每个账号最多 10 个分组")
		}
		e.Groups = clean
	}
	if v, ok := b.Get("priority"); ok {
		p, ok := asSafeInt(v)
		if !ok || p < -100 || p > 100 {
			return nil, herr(400, "优先级只能是 -100 到 100 的整数")
		}
		e.Priority = int(p)
	}
	old, had := s.m[id]
	s.m[id] = e
	if err := s.save(); err != nil {
		if had {
			s.m[id] = old
		} else {
			delete(s.m, id)
		}
		return nil, err
	}
	return s.json(id, e), nil
}
func (s *AccountSched) json(id int, e SchedEntry) *Obj {
	gs := []any{}
	for _, g := range e.Groups {
		gs = append(gs, g)
	}
	return NewObj().Set("id", id).Set("groups", gs).Set("priority", e.Priority)
}
func (s *AccountSched) JSON(id int) *Obj { return s.json(id, s.Get(id)) }

var _ = time.Now