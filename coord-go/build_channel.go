package main

// build-coordinator.js (settings, channel, ledger), build-headless.js (callBuild/readFile), build-applet-rotation.js.
import (
	"context"
	"encoding/base64"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// ---------------- settings / document switch ----------------
type BuildSettings struct {
	mu          sync.Mutex
	file        string
	PremiumOnly bool
}

func NewBuildSettings(file string) *BuildSettings {
	s := &BuildSettings{file: file, PremiumOnly: true}
	if raw, err := readJSONFile(file); err == nil {
		if b, ok := asObj(raw).V("premiumOnly").(bool); ok {
			s.PremiumOnly = b
		}
	}
	return s
}
func (s *BuildSettings) Status() *Obj { s.mu.Lock(); defer s.mu.Unlock(); return NewObj().Set("premiumOnly", s.PremiumOnly) }
func (s *BuildSettings) Set(b *Obj) (*Obj, error) {
	s.mu.Lock()
	next := s.PremiumOnly
	if v, ok := b.Get("premiumOnly"); ok && v != nil {
		bv, isB := v.(bool)
		if !isB {
			s.mu.Unlock()
			return nil, herr(400, "premiumOnly 必须是 true/false")
		}
		next = bv
	}
	if err := writeSimple(s.file, MarshalJSIndent(NewObj().Set("premiumOnly", next), " "), 0644); err != nil {
		s.mu.Unlock()
		return nil, err
	}
	s.PremiumOnly = next
	s.mu.Unlock()
	return s.Status(), nil
}
func (s *BuildSettings) premium() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.PremiumOnly }

var docPrefixes = []string{"build/", "build-st/", "bridge/", "code/"}

type DocSwitch struct {
	mu       sync.Mutex
	file     string
	enabled  bool
	prefixes map[string]bool
	requests int64
}

func NewDocSwitch(file string) *DocSwitch {
	d := &DocSwitch{file: file, prefixes: map[string]bool{"build/": true, "build-st/": true, "bridge/": true, "code/": false}}
	if raw, err := readJSONFile(file); err == nil {
		o := asObj(raw)
		if b, ok := o.V("enabled").(bool); ok {
			d.enabled = b
		}
		for _, k := range docPrefixes {
			if b, ok := o.Obj("prefixes").V(k).(bool); ok {
				d.prefixes[k] = b
			}
		}
	}
	return d
}
func (d *DocSwitch) prefJSON() *Obj {
	o := NewObj()
	for _, k := range docPrefixes {
		o.Set(k, d.prefixes[k])
	}
	return o
}
func (d *DocSwitch) Status() *Obj {
	d.mu.Lock()
	defer d.mu.Unlock()
	return NewObj().Set("enabled", d.enabled).Set("prefixes", d.prefJSON()).Set("stats", NewObj().Set("requests", d.requests))
}
func (d *DocSwitch) Uses(prefix string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.enabled && d.prefixes[prefix]
}
func (d *DocSwitch) Set(b *Obj) (*Obj, error) {
	d.mu.Lock()
	en := d.enabled
	pre := map[string]bool{}
	for k, v := range d.prefixes {
		pre[k] = v
	}
	if v, ok := b.Get("enabled"); ok && v != nil {
		bv, isB := v.(bool)
		if !isB {
			d.mu.Unlock()
			return nil, herr(400, "enabled 必须是 true/false")
		}
		en = bv
	}
	if v, ok := b.Get("prefixes"); ok && v != nil {
		po := asObj(v)
		if po == nil {
			d.mu.Unlock()
			return nil, herr(400, "prefixes 无效")
		}
		for _, k := range po.Keys() {
			bv, isB := po.V(k).(bool)
			if !inStrs(k, docPrefixes...) || !isB {
				d.mu.Unlock()
				return nil, herr(400, "未知前缀或取值："+k)
			}
			pre[k] = bv
		}
	}
	old := d.prefixes
	d.prefixes = pre
	data := MarshalJSIndent(NewObj().Set("enabled", en).Set("prefixes", d.prefJSON()), " ")
	if err := writeSimple(d.file, data, 0644); err != nil {
		d.prefixes = old
		d.mu.Unlock()
		return nil, err
	}
	d.enabled = en
	d.mu.Unlock()
	return d.Status(), nil
}

// ---------------- token ledger (build-tokens.json) ----------------
type TokenLedger struct {
	mu       sync.Mutex
	file     string
	data     *Obj
	reserved map[int]int64
	tierOf   func(int) string
}

func NewTokenLedger(file string, tierOf func(int) string) *TokenLedger {
	l := &TokenLedger{file: file, reserved: map[int]int64{}, tierOf: tierOf, data: NewObj().Set("version", 1).Set("accounts", NewObj())}
	if raw, err := readJSONFile(file); err == nil {
		if o := asObj(raw); o != nil && num64(o.V("version")) == 1 && o.Obj("accounts") != nil {
			l.data = o
		}
	}
	return l
}

// All tiers are unlimited (null) by default; usage is still recorded.
func (l *TokenLedger) entry(id int, now int64) *Obj {
	a := l.data.Obj("accounts").Obj(itoa(id))
	if a == nil || num64(a.V("windowStart")) < periodStart(now) {
		var cd int64
		if a != nil {
			cd = num64(a.V("cooldownUntil"))
		}
		return NewObj().Set("used", 0).Set("windowStart", periodStart(now)).Set("cooldownUntil", cd).Set("requests", 0).
			Set("input", 0).Set("output", 0).Set("cached", 0).Set("failed", 0).Set("models", NewObj())
	}
	return a
}
func (l *TokenLedger) viewL(id int, now int64) *Obj {
	e := l.entry(id, now)
	cd := num64(e.V("cooldownUntil"))
	models := e.Obj("models")
	if models == nil {
		models = NewObj()
	}
	return NewObj().Set("account", id).Set("tier", l.tierOf(id)).Set("limit", nil).Set("used", num64(e.V("used"))).Set("reserved", l.reserved[id]).
		Set("remaining", nil).Set("requests", num64(e.V("requests"))).Set("input", num64(e.V("input"))).Set("output", num64(e.V("output"))).
		Set("cached", num64(e.V("cached"))).Set("failed", num64(e.V("failed"))).Set("models", models).
		Set("windowStart", periodStart(now)).Set("windowEnd", periodStart(now)+DAY).Set("cooldownUntil", cd).
		Set("unlimited", true).Set("allowed", cd <= now)
}
func (l *TokenLedger) View(id int) *Obj { l.mu.Lock(); defer l.mu.Unlock(); return l.viewL(id, nowMs()) }
func (l *TokenLedger) Allowed(id int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return num64(l.entry(id, nowMs()).V("cooldownUntil")) <= nowMs()
}
func (l *TokenLedger) Reserve(id int, n int64) int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n < 0 {
		n = 0
	}
	l.reserved[id] += n
	return n
}
func (l *TokenLedger) Release(id int, n int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if left := l.reserved[id] - n; left > 0 {
		l.reserved[id] = left
	} else {
		delete(l.reserved, id)
	}
}
func (l *TokenLedger) save() { writeSimple(l.file, MarshalJS(l.data), 0600) }
func pos64(v *int64) int64 {
	if v == nil || *v < 0 {
		return 0
	}
	return *v
}
func (l *TokenLedger) Charge(id int, tokens int64, model string, in, out, cached *int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if tokens < 0 {
		tokens = 0
	}
	e := l.entry(id, nowMs())
	models := NewObj()
	if m := e.Obj("models"); m != nil {
		models = m.Clone()
	}
	if model != "" {
		m := models.Obj(model)
		models.Set(model, NewObj().Set("requests", num64(m.V("requests"))+1).Set("tokens", num64(m.V("tokens"))+tokens))
	}
	l.data.Obj("accounts").Set(itoa(id), NewObj().Set("used", num64(e.V("used"))+tokens).Set("windowStart", num64(e.V("windowStart"))).
		Set("cooldownUntil", num64(e.V("cooldownUntil"))).Set("requests", num64(e.V("requests"))+1).
		Set("input", num64(e.V("input"))+pos64(in)).Set("output", num64(e.V("output"))+pos64(out)).Set("cached", num64(e.V("cached"))+pos64(cached)).
		Set("failed", num64(e.V("failed"))).Set("models", models))
	l.save()
}
func (l *TokenLedger) Fail(id int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.entry(id, nowMs()).Clone()
	e.Set("failed", num64(e.V("failed"))+1)
	l.data.Obj("accounts").Set(itoa(id), e)
	l.save()
}
func (l *TokenLedger) Defer(id int, until int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	e := l.entry(id, nowMs()).Clone()
	if until > num64(e.V("cooldownUntil")) {
		e.Set("cooldownUntil", until)
	}
	l.data.Obj("accounts").Set(itoa(id), e)
	l.save()
}
func (l *TokenLedger) Log(item *Obj) {
	l.mu.Lock()
	defer l.mu.Unlock()
	r := append(append([]any(nil), l.data.Arr("recent")...), item)
	if len(r) > 50 {
		r = r[len(r)-50:]
	}
	l.data.Set("recent", r)
	l.save()
}
func (l *TokenLedger) Recent() []any {
	l.mu.Lock()
	defer l.mu.Unlock()
	r := l.data.Arr("recent")
	out := make([]any, 0, len(r))
	for i := len(r) - 1; i >= 0; i-- {
		out = append(out, r[i])
	}
	return out
}
func (l *TokenLedger) Limits() *Obj {
	return NewObj().Set("standard", nil).Set("pro", nil).Set("ultra", nil).Set("ultra20", nil)
}

// ---------------- channel ----------------
type reservation struct {
	account int
	n       int64
}
type Build struct {
	app          *App
	appsFile     string
	settings     *BuildSettings
	doc          *DocSwitch
	presets      *PresetStore
	ledger       *TokenLedger
	mu           sync.Mutex
	reservations map[string]reservation
	inflight     map[int]map[string]int64
	denied       map[string]int64
	maxInflight  int
	maxPremium   int
	stats        *Obj
}

func envCap(name string, def int) int {
	if n, err := strconv.Atoi(os.Getenv(name)); err == nil && n >= 1 && n <= 10 {
		return n
	}
	return def
}

func NewBuild(app *App) *Build {
	r := app.root
	b := &Build{app: app, appsFile: r + "/build-apps.json", settings: NewBuildSettings(r + "/build-settings.json"), doc: NewDocSwitch(r + "/build-document.json"),
		presets: &PresetStore{file: r + "/build-presets.json"}, ledger: NewTokenLedger(r+"/build-tokens.json", app.acc.Tier),
		reservations: map[string]reservation{}, inflight: map[int]map[string]int64{}, denied: map[string]int64{},
		maxInflight: envCap("BUILD_MAX_INFLIGHT_PER_ACCOUNT", 1), maxPremium: envCap("BUILD_MAX_INFLIGHT_PREMIUM", 2),
		stats: NewObj().Set("requests", 0).Set("charged", 0).Set("missingUsage", 0).Set("rejected", 0)}
	return b
}

func (b *Build) inc(k string, n int64) { b.stats.Set(k, num64(b.stats.V(k))+n) }

func (b *Build) Apps() map[int]string {
	out := map[int]string{}
	raw, err := readJSONFile(b.appsFile)
	if err != nil {
		return out
	}
	o := asObj(raw)
	for _, k := range o.Keys() {
		id, err := strconv.Atoi(k)
		v := strings.ToLower(jsStr(o.V(k)))
		if err == nil && reDigits.MatchString(k) && reAPP.MatchString(v) {
			out[id] = v
		}
	}
	return out
}
func (b *Build) AppFor(id int) string { return b.Apps()[id] }

func (b *Build) Busy(id int) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.busyL(id)
}
func (b *Build) busyL(id int) int {
	m := b.inflight[id]
	stale := nowMs() - 15*60000
	for k, t := range m {
		if t < stale {
			delete(m, k)
		}
	}
	return len(m)
}
func (b *Build) capFor(id int) int {
	if b.app.acc.IsPremium(id) {
		return b.maxPremium
	}
	return b.maxInflight
}
func (b *Build) canUse(id int, model string) bool {
	free := b.app.acc.Tier(id) == "standard"
	return !free || (!b.settings.premium() && strings.Contains(model, "flash"))
}
func (b *Build) blocked(id int, model string) bool {
	b.mu.Lock()
	d := b.denied[itoa(id)+"|"+model]
	b.mu.Unlock()
	return !b.canUse(id, model) || d > nowMs()
}
func (b *Build) ready(id int, model string) bool {
	return b.AppFor(id) != "" && b.ledger.Allowed(id) && !b.blocked(id, model)
}

// Resolve returns nil for non-Build models.
func (b *Build) Resolve(route string, parsed *Obj, allowUnavailable bool) (*Plan, error) {
	spec, err := parseBuildModel(parsed.Str("model"))
	if err != nil {
		return nil, err
	}
	if spec == nil {
		return nil, nil
	}
	if route != "/v1/chat/completions" {
		return nil, herr(400, "Build 通道只支持 /v1/chat/completions")
	}
	apps := b.Apps()
	if len(apps) == 0 {
		return nil, herr(503, "没有已开通 Build 项目的账号")
	}
	if !allowUnavailable {
		all, some := true, false
		for id := range apps {
			if !b.blocked(id, spec.Model) {
				all = false
			}
			if b.canUse(id, spec.Model) {
				some = true
			}
		}
		if all {
			msg := spec.Model + " 需要 Pro/Ultra 账号，当前只有 Free 账号可用，请改用 flash 模型"
			if some {
				msg = "没有账号能使用 " + spec.Model + "（Google 拒绝），请换模型"
			} else if b.settings.premium() {
				msg = "Build 通道已设为只用 Pro/Ultra 账号，当前没有可用的 Pro/Ultra 账号"
			}
			return nil, herr(403, msg)
		}
		any := false
		var soon int64 = 1 << 62
		for id := range apps {
			v := b.ledger.View(id)
			if v.V("allowed") == true {
				any = true
			}
			if cd := num64(v.V("cooldownUntil")); cd < soon {
				soon = cd
			}
		}
		if !any {
			ra := (soon - nowMs() + 999) / 1000
			if ra < 1 {
				ra = 1
			}
			return nil, &HTTPError{Status: 429, Msg: "Build 通道暂不可用（冷却或额度），约 " + bjTime(soon) + "（北京时间）恢复", RetryAfter: ra}
		}
	}
	var est int64
	for _, m := range parsed.Arr("messages") {
		c := asObj(m).V("content")
		s, ok := c.(string)
		if !ok {
			if c == nil {
				s = ""
			} else {
				s = string(MarshalJS(c))
			}
		}
		est += int64(btokens(s))
	}
	plan := &Plan{Model: "build-" + spec.Model, Family: "ultra", Build: spec, Estimate: est}
	plan.Eligible = func(a int) bool { return b.ready(a, spec.Model) }
	if strings.Contains(spec.Model, "flash") && !b.settings.premium() {
		plan.Rank = func(a int) (float64, bool) {
			if b.app.acc.IsPremium(a) {
				return 1, true
			}
			return 0, true
		}
	}
	plan.Admit = func(a int, id string) bool {
		if !b.ready(a, spec.Model) {
			return false
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.busyL(a) >= b.capFor(a) {
			b.inc("waitedInflight", 1)
			return false
		}
		if b.inflight[a] == nil {
			b.inflight[a] = map[string]int64{}
		}
		b.inflight[a][id] = nowMs()
		b.reservations[id] = reservation{a, b.ledger.Reserve(a, est)}
		return true
	}
	return plan, nil
}

func (b *Build) free(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, m := range b.inflight {
		delete(m, id)
	}
}

func (b *Build) Status() *Obj {
	apps := b.Apps()
	ao := NewObj()
	var ids []int
	for id := range apps {
		ids = append(ids, id)
	}
	sortInts(ids)
	accs := []any{}
	now := nowMs()
	for _, id := range ids {
		ao.Set(itoa(id), apps[id])
		v := b.ledger.View(id).Set("premium", b.app.acc.IsPremium(id)).Set("app", apps[id])
		dm := []any{}
		b.mu.Lock()
		for k, t := range b.denied {
			if t > now && strings.HasPrefix(k, itoa(id)+"|") {
				dm = append(dm, k[len(itoa(id))+1:])
			}
		}
		b.mu.Unlock()
		accs = append(accs, v.Set("deniedModels", dm))
	}
	b.mu.Lock()
	stats := b.stats.Clone()
	b.mu.Unlock()
	ms := []any{}
	for _, m := range buildModels() {
		ms = append(ms, m)
	}
	return NewObj().Set("apps", ao).Set("stats", stats).Set("settings", b.settings.Status()).Set("document", b.doc.Status()).
		Set("presets", b.presets.List()).Set("limits", b.ledger.Limits()).Set("maxContextBytes", bMaxBytes).Set("inlineBudget", bInlineBudget).
		Set("windowStart", periodStart(now)).Set("windowEnd", periodStart(now)+DAY).Set("models", ms).Set("accounts", accs).Set("recent", b.ledger.Recent())
}

// ---------------- headless Build calls ----------------
type rawFn func(ctx context.Context, call *Obj, deadline time.Duration) (*Obj, error)

type buildResult struct {
	s                                  int
	stage, t                           string
	tries, polls, resent, firstModel   int
}

var reBuildFailed = regexp.MustCompile(`\[null,null,null,null,null,\["[^"]{1,300}",\[`)

func errStatus(err error) int {
	if re, ok := err.(*RawError); ok {
		return re.Status
	}
	return 0
}

func callBuild(parent context.Context, raw rawFn, account string, parts []BPart, model string, thinking int, app string, hard time.Duration) buildResult {
	if !reAPP.MatchString(app) {
		return buildResult{s: 400, stage: "args", t: "invalid applet"}
	}
	ctx, cancel := context.WithTimeout(parent, hard)
	defer cancel()
	t0 := time.Now()
	gid := ""
	defer func() {
		if gid != "" {
			go raw(context.Background(), NewObj().Set("op", "rpc").Set("account", account).Set("method", "CancelCodeAssistantOfflineGeneration").Set("body", []any{gid, app}), 30*time.Second)
		}
	}()
	fail := func(err error) buildResult {
		if parent.Err() != nil {
			return buildResult{s: 499, stage: "cancel", t: "cancelled"}
		}
		if ctx.Err() != nil {
			return buildResult{s: 504, stage: "fetch", t: "timeout after " + hard.String()}
		}
		st := errStatus(err)
		if st == 0 || st == 499 {
			st = 502
		}
		return buildResult{s: st, stage: "fetch", t: clipRunes(err.Error(), 200)}
	}
	wire := make([]any, len(parts))
	for i, p := range parts {
		if p.Upload == nil {
			wire[i] = p.Wire
			continue
		}
		r, err := raw(ctx, NewObj().Set("op", "upload").Set("account", account).Set("mime", p.Upload.mime).Set("data", p.Upload.data), 120*time.Second)
		if err != nil {
			return fail(err)
		}
		if rawS(r) != 200 || !truthy(r.V("path")) {
			return buildResult{s: 502, stage: "upload", t: "upload " + itoa(rawS(r)) + " " + clipRunes(rawT(r), 300)}
		}
		dec, _ := base64.StdEncoding.DecodeString(p.Upload.data)
		w := make([]any, 18)
		w[17] = []any{p.Upload.mime, r.V("path"), p.Upload.name, strconv.Itoa(len(dec))}
		wire[i] = w
	}
	var bind []string
	for _, w := range wire {
		a := w.([]any)
		if len(a) > 1 && a[1] != nil {
			bind = append(bind, jsStr(a[1]))
		} else if len(a) > 2 {
			if x, ok := a[2].([]any); ok && len(x) > 1 {
				bind = append(bind, jsStr(x[1]))
				continue
			}
			bind = append(bind, "")
		} else {
			bind = append(bind, "")
		}
	}
	binding := strings.Join(bind, " ")
	res := buildResult{}
	var r1, r2 *Obj
	t2 := ""
	for g := 0; ; g++ {
		for tg := 1; ; tg++ {
			res.tries++
			var think any
			if thinking > 0 {
				think = []any{1, nil, nil, thinking}
			}
			body := []any{[]any{[]any{wire, "user"}}, nil, nil, nil, nil, 2, nil, "models/" + model, nil, nil, nil, app, nil, []any{2}, nil, 1, nil, nil, think,
				nil, nil, nil, true, nil, nil, nil, nil, nil, strings.ToUpper(uuid4())}
			var err error
			r1, err = raw(ctx, NewObj().Set("op", "submit").Set("account", account).Set("body", body).Set("binding", binding), 120*time.Second)
			if err != nil {
				return fail(err)
			}
			if rawS(r1) == 403 && reSignature.MatchString(rawT(r1)) && tg < 8 {
				select {
				case <-ctx.Done():
					return fail(ctx.Err())
				case <-time.After(time.Duration(1500*res.tries) * time.Millisecond):
				}
				continue
			}
			break
		}
		if rawS(r1) != 200 {
			return buildResult{s: rawS(r1), stage: "create", tries: res.tries, t: clipRunes(rawT(r1), 2000)}
		}
		gid = ""
		if a, err := ParseJSON([]byte(rawT(r1))); err == nil {
			if arr, ok := a.([]any); ok && len(arr) > 0 {
				gid, _ = arr[0].(string)
			}
		}
		if gid == "" {
			return buildResult{s: 502, stage: "create", tries: res.tries, t: "no generation id: " + clipRunes(rawT(r1), 300)}
		}
		done := regexp.MustCompile(`\["\d+","\d+"(?:,"\d+")?\],"` + regexp.QuoteMeta(gid) + `"\]`)
		res.polls, res.firstModel = 0, 0
		for {
			res.polls++
			left := hard - time.Since(t0)
			if left < 5*time.Second {
				left = 5 * time.Second
			}
			var err error
			r2, err = raw(ctx, NewObj().Set("op", "rpc").Set("account", account).Set("method", "StreamCodeAssistantOfflineGeneration").Set("body", []any{gid, nil, nil, app}), left)
			if err != nil {
				return fail(err)
			}
			if rawS(r2) != 200 {
				if t2 == "" {
					t2 = rawT(r2)
				}
				break
			}
			t2 = rawT(r2)
			if res.firstModel == 0 && strings.Contains(t2, `"model"]`) {
				res.firstModel = res.polls
			}
			if reBuildFailed.MatchString(t2) || done.MatchString(t2) || res.polls >= 20 {
				break
			}
			if res.firstModel == 0 && res.polls >= 12 && g < 1 {
				break
			}
			select {
			case <-ctx.Done():
				return fail(ctx.Err())
			case <-time.After(time.Second):
			}
		}
		if rawS(r2) == 200 && res.firstModel == 0 && !done.MatchString(t2) && g < 1 && !reBuildFailed.MatchString(t2) {
			res.resent++
			continue
		}
		break
	}
	gid = ""
	res.s, res.stage, res.t = rawS(r2), "stream", t2
	return res
}

func buildReadFile(ctx context.Context, raw rawFn, account, app, hash string) (string, int, string) {
	r, err := raw(ctx, NewObj().Set("op", "file").Set("account", account).Set("applet", app).Set("hash", hash), 60*time.Second)
	if err != nil {
		return "", 0, "status_" + itoa(errStatus(err))
	}
	d, ok := r.V("data").(string)
	if rawS(r) != 200 || !ok {
		switch rawS(r) {
		case 409:
			return "", 0, "hash_mismatch"
		case 413:
			return "", 0, "too_large"
		}
		return "", 0, "status_" + itoa(rawS(r))
	}
	b, _ := base64.StdEncoding.DecodeString(d)
	if !utf8.Valid(b) {
		return "", len(b), "not_utf8"
	}
	return strings.TrimPrefix(string(b), "\uFEFF"), len(b), ""
}

// ---------------- applet rotation (build-applet-rotation.js) ----------------
type Rotation struct {
	b            *Build
	stateFile    string
	mu           sync.Mutex
	running      bool
	ensuring     map[int]bool
	ensureAfter  map[int]int64
	last         *Obj
}

func createAppletRequest() []any {
	name, desc := "GW Text Bridge", "Minimal private project for text-chat context files."
	meta := []any{name, desc}
	md := MarshalJSIndent(NewObj().Set("name", name).Set("description", desc).Set("requestFramePermissions", []any{}), "  ")
	html := []byte("<!doctype html><html><body>Ready</body></html>\n")
	return []any{nil, meta, nil, []any{meta, []any{[]any{"metadata.json", base64.StdEncoding.EncodeToString(md)}, []any{"index.html", base64.StdEncoding.EncodeToString(html)}}}}
}

func (ro *Rotation) rpc(email, method string, body any) (int, string, error) {
	r, err := ro.b.app.svc.Raw(context.Background(), NewObj().Set("op", "rpc").Set("account", email).Set("method", method).Set("body", body), 90*time.Second)
	if err != nil {
		return 0, "", err
	}
	if rawS(r) == 0 {
		return 0, "", &RawError{502, "headless rpc failed"}
	}
	return rawS(r), rawT(r), nil
}
func parseCreated(status int, text string) string {
	if status != 200 {
		return ""
	}
	v, err := ParseJSON([]byte(text))
	if a, ok := v.([]any); err == nil && ok && len(a) > 0 {
		if id := strings.ToLower(jsStr(a[0])); reAPP.MatchString(id) {
			return id
		}
	}
	return ""
}
func (ro *Rotation) readApps() *Obj {
	raw, err := readJSONFile(ro.b.appsFile)
	if err != nil {
		return nil
	}
	return asObj(raw)
}
func (ro *Rotation) writeApps(o *Obj) { writeSimple(ro.b.appsFile, MarshalJS(o), 0600) }
func (ro *Rotation) readState() *Obj {
	if raw, err := readJSONFile(ro.stateFile); err == nil {
		if s := asObj(raw); s != nil && s.Obj("accounts") != nil {
			return s
		}
	}
	return NewObj().Set("accounts", NewObj())
}
func (ro *Rotation) writeState(s *Obj) { writeSimple(ro.stateFile, MarshalJSIndent(s, " "), 0644) }
func stEntry(state *Obj, key string) *Obj {
	st := state.Obj("accounts").Obj(key)
	if st == nil {
		st = NewObj().Set("lastAt", 0).Set("pendingDelete", []any{})
		state.Obj("accounts").Set(key, st)
	}
	if st.Arr("pendingDelete") == nil {
		st.Set("pendingDelete", []any{})
	}
	return st
}

func (ro *Rotation) Ensure(id int, email string) string {
	if id < 1 || email == "" {
		return "invalid"
	}
	apps := ro.readApps()
	if apps == nil && fileExists(ro.b.appsFile) {
		return "apps_unreadable"
	}
	if reAPP.MatchString(strings.ToLower(jsStr(apps.V(itoa(id))))) {
		return "present"
	}
	ro.mu.Lock()
	if ro.running || ro.ensuring[id] {
		ro.mu.Unlock()
		return "busy"
	}
	if ro.ensureAfter[id] > nowMs() {
		ro.mu.Unlock()
		return "backoff"
	}
	ro.ensuring[id] = true
	ro.mu.Unlock()
	defer func() { ro.mu.Lock(); delete(ro.ensuring, id); ro.mu.Unlock() }()
	backoff := func() { ro.mu.Lock(); ro.ensureAfter[id] = nowMs() + 120000; ro.mu.Unlock() }
	s, t, err := ro.rpc(email, "CreateApplet", createAppletRequest())
	if err != nil {
		backoff()
		return "create_failed:" + clipRunes(err.Error(), 60)
	}
	created := parseCreated(s, t)
	if created == "" {
		backoff()
		return "create_failed"
	}
	fresh := ro.readApps()
	if fresh == nil {
		fresh = NewObj()
	}
	if reAPP.MatchString(strings.ToLower(jsStr(fresh.V(itoa(id))))) {
		ro.rpc(email, "DeleteApplet", []any{created})
		return "present"
	}
	fresh.Set(itoa(id), created)
	ro.writeApps(fresh)
	state := ro.readState()
	st := stEntry(state, itoa(id))
	st.Set("lastAt", nowMs()).Set("app", created).Set("provisionedAt", nowMs())
	ro.writeState(state)
	ro.mu.Lock()
	delete(ro.ensureAfter, id)
	ro.mu.Unlock()
	logf("[BuildProvision] #%d on %s -> new Build project %s", id, email, created[:8])
	return "created"
}

func deletedOK(s int) bool { return s == 200 || s == 404 }

func (ro *Rotation) Renew(id int, email string) string {
	if id < 1 || email == "" {
		return "invalid"
	}
	ro.mu.Lock()
	if ro.running || ro.ensuring[id] {
		ro.mu.Unlock()
		return "busy"
	}
	ro.mu.Unlock()
	apps := ro.readApps()
	if apps == nil {
		return "apps_unreadable"
	}
	key := itoa(id)
	cur := strings.ToLower(jsStr(apps.V(key)))
	if !reAPP.MatchString(cur) {
		return "no_project"
	}
	ro.mu.Lock()
	ro.ensuring[id] = true
	ro.mu.Unlock()
	defer func() { ro.mu.Lock(); delete(ro.ensuring, id); ro.mu.Unlock() }()
	state := ro.readState()
	st := stEntry(state, key)
	s, t, err := ro.rpc(email, "CreateApplet", createAppletRequest())
	if err != nil {
		return "create_failed:" + clipRunes(err.Error(), 40)
	}
	created := parseCreated(s, t)
	if created == "" {
		return "create_failed"
	}
	fresh := ro.readApps()
	if fresh == nil {
		ro.rpc(email, "DeleteApplet", []any{created})
		return "apps_unreadable"
	}
	if strings.ToLower(jsStr(fresh.V(key))) != cur {
		ro.rpc(email, "DeleteApplet", []any{created})
		return "changed"
	}
	fresh.Set(key, created)
	ro.writeApps(fresh)
	st.Set("lastAt", nowMs()).Set("app", created)
	st.Del("lastError")
	queue := []string{}
	seen := map[string]bool{}
	for _, x := range append(append([]any(nil), st.Arr("pendingDelete")...), cur) {
		if s := jsStr(x); !seen[s] {
			seen[s] = true
			queue = append(queue, s)
		}
	}
	left := []any{}
	pendingCur := false
	for _, old := range queue {
		s, _, err := ro.rpc(email, "DeleteApplet", []any{old})
		if err != nil || !deletedOK(s) {
			left = append(left, old)
			if old == cur {
				pendingCur = true
			}
		}
	}
	st.Set("pendingDelete", left)
	ro.writeState(state)
	r := "renewed"
	if pendingCur {
		r = "renewed_delete_pending"
	}
	logf("[BuildRenew] #%s %s -> %s %s", key, cur[:8], created[:8], r)
	return r
}

func bjHour(t int64) int { return time.UnixMilli(t + 8*3600000).UTC().Hour() }

func (ro *Rotation) Tick(force bool, only int) *Obj {
	ro.mu.Lock()
	if ro.running || len(ro.ensuring) > 0 {
		ro.mu.Unlock()
		return NewObj().Set("skipped", "running")
	}
	if h := bjHour(nowMs()); !force && (h < 3 || h >= 6) {
		ro.mu.Unlock()
		return NewObj().Set("skipped", "window")
	}
	ro.running = true
	ro.mu.Unlock()
	defer func() { ro.mu.Lock(); ro.running = false; ro.mu.Unlock() }()
	apps := ro.readApps()
	if apps == nil {
		return NewObj().Set("skipped", "apps_unreadable")
	}
	state := ro.readState()
	results := NewObj()
	for _, key := range apps.Keys() {
		cur := strings.ToLower(jsStr(apps.V(key)))
		if !reDigits.MatchString(key) || !reAPP.MatchString(cur) {
			continue
		}
		id, _ := strconv.Atoi(key)
		if only > 0 && id != only {
			continue
		}
		email := ""
		if ro.b.app.importer.Has(id) {
			email = ro.b.app.acc.Email(id)
		}
		st := stEntry(state, key)
		if email == "" {
			results.Set(key, "offline")
			continue
		}
		var keep []any
		for _, old := range st.Arr("pendingDelete") {
			o := jsStr(old)
			if o == cur {
				keep = append(keep, old)
				continue
			}
			if s, _, err := ro.rpc(email, "DeleteApplet", []any{o}); err != nil || !deletedOK(s) {
				keep = append(keep, old)
			}
		}
		if keep == nil {
			keep = []any{}
		}
		st.Set("pendingDelete", keep)
		if !force && nowMs()-num64(st.V("lastAt")) < 20*3600000 {
			results.Set(key, "recent")
			continue
		}
		s, t, err := ro.rpc(email, "CreateApplet", createAppletRequest())
		created := ""
		if err == nil {
			created = parseCreated(s, t)
		}
		if created == "" {
			results.Set(key, "create_failed")
			st.Set("lastError", "create_failed")
			continue
		}
		fresh := ro.readApps()
		if fresh == nil {
			results.Set(key, "error")
			st.Set("lastError", "apps_unreadable")
			continue
		}
		fresh.Set(key, created)
		ro.writeApps(fresh)
		st.Set("lastAt", nowMs()).Set("app", created)
		st.Del("lastError")
		if s, _, err := ro.rpc(email, "DeleteApplet", []any{cur}); err == nil && deletedOK(s) {
			results.Set(key, "rotated")
		} else {
			st.Set("pendingDelete", append(st.Arr("pendingDelete"), cur))
			results.Set(key, "rotated_delete_pending")
		}
		logf("[BuildRotation] #%s %s -> %s %s", key, cur[:8], created[:8], results.Str(key))
	}
	ro.writeState(state)
	ro.mu.Lock()
	ro.last = NewObj().Set("at", nowMs()).Set("results", results)
	ro.mu.Unlock()
	return results
}

func (ro *Rotation) Status() *Obj {
	ro.mu.Lock()
	var last any
	if ro.last != nil {
		last = ro.last
	}
	ro.mu.Unlock()
	return NewObj().Set("window", []any{3, 6}).Set("last", last).Set("accounts", ro.readState().Obj("accounts"))
}

func sortInts(a []int) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}