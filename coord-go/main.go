package main

// Coordinator (no-browser mode), Go version. Same public API, same state files as start-headless.js.
// Flags: -addr (default 127.0.0.1:8890), -readonly (never write state.json; for side-by-side tests).
import (
	"errors"
	"flag"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type App struct {
	mu       sync.Mutex // dispatch, scheduler, core
	root     string
	cfg      *Obj
	keys     []string
	core     *Core
	acc      *Accounts
	importer *Importer
	sched    *AccountSched
	disp     *Dispatch
	sch      *Scheduler
	svc      *Service
	routing  *Routing
	policies *PolicyStore
	prices   *PriceStore
	hist     *History
	health   *RecordHealth
	atPrompt *AtPromptStore
	build    *Build
	rotation *Rotation
	auth     *ConsoleAuth
	stream   *StreamMode
	perAcc   int
	ccFile   string
	disFile  string
	stopping bool
	renewMu  sync.Mutex
	renewing map[int]bool
	reloadMu sync.Mutex
	reloadT  *time.Timer
	reloadN  int
}

func dualRoot() string {
	if r := os.Getenv("DUAL_ROOT"); r != "" {
		return r
	}
	return "/opt/ais2api/dual-runtime"
}

func (a *App) perAccount() int { return a.perAcc }

func (a *App) liveIDs() []int {
	var out []int
	for _, id := range a.core.Ids {
		if !a.core.Deleted(id) {
			out = append(out, id)
		}
	}
	return out
}

func intsAny(x []int) []any {
	o := []any{}
	for _, v := range x {
		o = append(o, v)
	}
	return o
}
func toAny(s []string) []any {
	o := []any{}
	for _, x := range s {
		o = append(o, x)
	}
	return o
}

func (a *App) syncImport() *Obj {
	a.mu.Lock()
	ids := a.liveIDs()
	a.mu.Unlock()
	r, skipped := a.importer.Sync(ids)
	res := NewObj().Set("changed", intsAny(r.Changed)).Set("added", intsAny(r.Added)).Set("skipped", skipped)
	if len(r.Added) > 0 || len(r.Changed) > 0 {
		logf("[Headless] imported %s", MarshalJS(res))
	}
	return res
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8890", "listen address")
	ro := flag.Bool("readonly", false, "never write shared state (side-by-side test)")
	flag.Parse()
	readOnlyState = *ro
	if err := start(*addr); err != nil {
		errf("[Coordinator] headless startup failed: %v", err)
		os.Exit(1)
	}
}

func start(addr string) error {
	root := dualRoot()
	a := &App{root: root, renewing: map[int]bool{}}
	raw, err := readJSONFile(filepath.Join(root, "coordinator.json"))
	if err != nil {
		return err
	}
	a.cfg = asObj(raw)
	for _, k := range a.cfg.Arr("apiKeys") {
		if s, ok := k.(string); ok && s != "" {
			a.keys = append(a.keys, s)
		}
	}
	if len(a.keys) == 0 {
		return errors.New("API keys required")
	}
	core, missing, err := LoadCore(filepath.Join(root, "state.json"))
	if err != nil {
		return err
	}
	a.core = core
	if len(missing) > 0 {
		core.Checkpoint()
	}
	if a.svc, err = ServiceFromFiles("/opt/as2a-nb"); err != nil {
		return err
	}
	a.acc = NewAccounts(AUTH_DIR, filepath.Join(root, "ultra-mode.json"))
	core.tierOf = a.acc.Tier
	a.importer = &Importer{acc: a.acc, target: "/opt/as2a-nb/auth", stateFile: "/opt/as2a-nb/import-state.json"}
	a.sched = NewAccountSched(filepath.Join(root, "account-schedule.json"))
	a.ccFile = filepath.Join(root, "headless-concurrency.json")
	a.perAcc = 2
	if n, err := strconv.Atoi(os.Getenv("HEADLESS_PER_ACCOUNT")); err == nil && n > 0 {
		a.perAcc = n
	}
	if raw, err := readJSONFile(a.ccFile); err == nil {
		if n, ok := asSafeInt(asObj(raw).V("perAccount")); ok && n >= 1 && n <= 10 {
			a.perAcc = int(n)
		}
	}
	a.disp = NewDispatch(a)
	a.disFile = filepath.Join(root, "headless-disabled.json")
	if raw, err := readJSONFile(a.disFile); err == nil {
		for _, x := range asArr(raw) {
			if n, ok := asSafeInt(x); ok {
				a.disp.disabled[int(n)] = true
			}
		}
	}
	if !readOnlyState {
		a.syncImport()
	}
	a.hist = OpenHistory(filepath.Join(root, "request-history"))
	a.health = NewRecordHealth(filepath.Join(root, "usage-missing.jsonl"))
	if a.prices, err = NewPriceStore(filepath.Join(root, "model-prices.json")); err != nil {
		return err
	}
	if a.policies, err = NewPolicyStore(filepath.Join(root, "model-policies.json"), a.cfg.Obj("modelPolicies")); err != nil {
		return err
	}
	if a.atPrompt, err = NewAtPromptStore(filepath.Join(root, "at-prompt.json"), atDefaultsPath()); err != nil {
		return err
	}
	a.stream = NewStreamMode(filepath.Join(root, "stream-mode.json"))
	a.routing = &Routing{app: a, models: map[string]bool{}}
	a.routing.Start()
	a.build = NewBuild(a)
	a.rotation = &Rotation{b: a.build, stateFile: filepath.Join(root, "build-applet-rotation.json"), ensuring: map[int]bool{}, ensureAfter: map[int]int64{}}
	if a.auth, err = NewConsoleAuth(filepath.Join(root, "console-auth.json"), a.keys[0]); err != nil {
		return err
	}
	a.sch = NewScheduler(a)

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: a, ReadHeaderTimeout: 30 * time.Second, IdleTimeout: 5 * time.Second}
	go srv.Serve(ln)

	if !readOnlyState {
		go a.stopBrowserWorkers()
		every(5*time.Minute, func() { a.hist.ExpireStale(900000) }, true)
		every(10*time.Minute, func() {
			if r := a.rotation.Tick(false, 0); r.V("skipped") == nil {
				logf("[BuildRotation] %s", MarshalJS(r))
			}
		}, false)
		time.AfterFunc(15*time.Second, a.provision)
		every(5*time.Minute, a.provision, false)
		time.AfterFunc(30*time.Second, a.writeBack)
		every(10*time.Minute, a.writeBack, false)
		every(time.Minute, func() {
			if r, err := a.syncAccounts(); err == nil && (len(r.Arr("added")) > 0 || len(r.Arr("removed")) > 0) {
				logf("[Accounts] synced %s", MarshalJS(NewObj().Set("added", r.V("added")).Set("removed", r.V("removed"))))
			}
		}, false)
		every(30*time.Second, func() {
			a.mu.Lock()
			if !a.stopping && a.core.TryResume() {
				errf("[Coordinator] state checkpoint succeeded again; dispatch resumed")
			}
			a.mu.Unlock()
		}, false)
	}
	a.mu.Lock()
	n := 0
	for _, id := range a.liveIDs() {
		if a.importer.Has(id) {
			n++
		}
	}
	a.mu.Unlock()
	logf("[Coordinator] %s; mode=headless (go); per-account concurrency %d; accounts %d; stream mode %s; readonly=%v", addr, a.perAcc, n, a.stream.Get(), readOnlyState)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	<-sig
	a.mu.Lock()
	a.stopping = true
	a.mu.Unlock()
	a.sch.Close()
	ln.Close()
	deadline := time.Now().Add(620 * time.Second)
	for time.Now().Before(deadline) {
		a.mu.Lock()
		act := a.disp.active
		a.mu.Unlock()
		if act == 0 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	a.mu.Lock()
	a.core.Checkpoint()
	a.mu.Unlock()
	return nil
}

func every(d time.Duration, fn func(), now bool) {
	go func() {
		if now {
			fn()
		}
		for range time.Tick(d) {
			fn()
		}
	}()
}

func (a *App) stopBrowserWorkers() {
	out, err := run(15*time.Second, "docker", "ps", "-q", "--filter", "label=operit.project=ais2api-dual", "--filter", "name=^ais2api-dual-[ab]$")
	if err != nil {
		return
	}
	ids := regexp.MustCompile(`\S+`).FindAllString(out, -1)
	if len(ids) == 0 {
		return
	}
	if _, err = run(90*time.Second, "docker", append([]string{"stop", "-t", "20"}, ids...)...); err != nil {
		logf("[Coordinator] browser workers stop failed: %v", err)
	} else {
		logf("[Coordinator] browser workers stopped (%d)", len(ids))
	}
}

func (a *App) provision() {
	if a.cfg.V("buildAutoProvision") == false {
		return
	}
	a.mu.Lock()
	var todo []int
	for _, id := range a.liveIDs() {
		if a.core.Flag(id) == nil {
			todo = append(todo, id)
		}
	}
	a.mu.Unlock()
	for _, id := range todo {
		if !a.importer.Has(id) || a.build.AppFor(id) != "" || (a.build.settings.premium() && !a.acc.IsPremium(id)) {
			continue
		}
		id := id
		go func() {
			if r := a.rotation.Ensure(id, a.acc.Email(id)); !inStrs(r, "present", "busy", "backoff") {
				logf("[BuildProvision] #%d %s", id, r)
			}
		}()
	}
}

func (a *App) writeBack() {
	a.mu.Lock()
	ids := a.liveIDs()
	a.mu.Unlock()
	if w := a.importer.WriteBack(ids).Arr("written"); len(w) > 0 {
		logf("[Headless] cookies written back %s", MarshalJS(w))
	}
}

// The service reads account directories at start-up: restart it once nothing is running on it.
func (a *App) reloadSoon() {
	a.reloadMu.Lock()
	defer a.reloadMu.Unlock()
	if a.reloadT != nil {
		return
	}
	a.reloadT = time.AfterFunc(5*time.Second, func() {
		a.reloadMu.Lock()
		a.reloadT = nil
		a.reloadMu.Unlock()
		a.mu.Lock()
		busy := a.disp.active > 0
		ids := append([]int(nil), a.core.Ids...)
		a.mu.Unlock()
		for _, id := range ids {
			if a.build.Busy(id) > 0 {
				busy = true
			}
		}
		a.reloadMu.Lock()
		if busy && a.reloadN < 120 {
			a.reloadN++
			a.reloadMu.Unlock()
			a.reloadSoon()
			return
		}
		a.reloadN = 0
		a.reloadMu.Unlock()
		if _, err := run(30*time.Second, "systemctl", "restart", "ais2api-headless"); err != nil {
			errf("[Headless] reload failed %v", err)
		} else {
			logf("[Headless] service reloaded for account changes")
		}
	})
}

var reAuthFile = regexp.MustCompile(`^auth-([1-9]\d*)\.json$`)

func (a *App) syncAccounts() (*Obj, error) {
	a.mu.Lock()
	if a.stopping {
		a.mu.Unlock()
		return NewObj().Set("added", []any{}).Set("reason", "coordinator_stopping"), nil
	}
	ents, err := os.ReadDir(AUTH_DIR)
	if err != nil {
		a.mu.Unlock()
		return nil, err
	}
	files := map[int]bool{}
	var fl []int
	for _, e := range ents {
		if m := reAuthFile.FindStringSubmatch(e.Name()); m != nil {
			n, _ := strconv.Atoi(m[1])
			files[n] = true
			fl = append(fl, n)
		}
	}
	sort.Ints(fl)
	c := a.core
	added, removed := []any{}, []any{}
	for _, id := range fl {
		if c.Deleted(id) && a.disp.busy(id) == 0 {
			f := c.Flag(id)
			mark := num64(f.V("deletedAt"))
			if mark == 0 {
				mark = num64(f.V("at"))
			}
			if st, err := os.Stat(a.acc.file(id)); err == nil && mtimeMs(st) > float64(mark) {
				c.SetFlag(id, nil)
				c.ClearCooldown(id)
				c.AuthSaves.Del(itoa(id))
				added = append(added, id)
			}
		}
		if c.InPool(id) {
			continue
		}
		c.AddAccount(id)
		added = append(added, id)
	}
	for _, id := range c.Ids {
		if files[id] || c.Deleted(id) || a.disp.busy(id) > 0 {
			continue
		}
		c.SetFlag(id, NewObj().Set("status", "deleted").Set("reason", "login_required").Set("at", nowMs()).Set("deletedAt", nowMs()))
		removed = append(removed, id)
	}
	if len(added) > 0 || len(removed) > 0 {
		c.Checkpoint()
	}
	pool := intsAny(c.Ids)
	var gone []int
	for id := range a.build.Apps() {
		if !c.InPool(id) || c.Deleted(id) {
			gone = append(gone, id)
		}
	}
	a.mu.Unlock()
	for _, id := range gone {
		if readOnlyState {
			continue
		}
		a.build.forget(id)
		a.rotation.forget(id)
		logf("[Build] #%d removed from the Build channel (account deleted)", id)
	}
	imp := a.syncImport()
	if len(removed) > 0 || len(imp.Arr("added")) > 0 || len(imp.Arr("changed")) > 0 {
		a.reloadSoon()
	}
	return NewObj().Set("added", added).Set("removed", removed).Set("pool", pool).Set("imported", imp), nil
}

// ---------------- status ----------------
func runModeStatus() *Obj {
	return NewObj().Set("mode", "headless").Set("single", false).Set("parked", nil).Set("serving", nil).Set("phase", "headless").
		Set("error", nil).Set("leaseActive", false).Set("modes", runModes)
}

func (a *App) cookieStatus(id int) *Obj {
	info := a.acc.FileInfo(id)
	f := a.core.Flag(id)
	login := "unverified"
	if f != nil && inStrs(f.Str("status"), "invalid", "deleting", "deleted") {
		login = "invalid"
	} else if a.importer.Has(id) {
		login = "online"
	}
	var exp, mod, save any
	expired := false
	if e, ok := asNum(info.V("expiresAt")); ok {
		exp = int64(e)
		expired = int64(e) <= nowMs()
	}
	if truthy(info.V("modifiedAt")) {
		mod = info.V("modifiedAt")
	}
	if s := a.core.AuthSaves.V(itoa(id)); s != nil {
		save = s
	}
	kc, _ := asNum(info.V("keyCookies"))
	return NewObj().Set("login", login).Set("file", info.V("state")).Set("keyCookies", kc).Set("expiresAt", exp).
		Set("session", info.V("session") == true).Set("expired", expired).Set("modifiedAt", mod).Set("save", save)
}

func (a *App) modelCooldownsL(id int) []any {
	out := []any{}
	acc := a.core.account(id, false)
	if acc == nil {
		return out
	}
	now := nowMs()
	for _, m := range acc.morder {
		if q := acc.models[m]; q.CooldownUntil > now {
			out = append(out, NewObj().Set("model", m).Set("until", q.CooldownUntil))
		}
	}
	return out
}

func (a *App) status() *Obj {
	a.mu.Lock()
	defer a.mu.Unlock()
	c := a.core
	execs := []any{}
	for _, t := range a.disp.executions {
		execs = append(execs, NewObj().Set("id", t.ID).Set("phase", t.Phase).Set("createdAt", t.CreatedAt).Set("account", t.Account))
	}
	accs := []any{}
	for _, id := range a.liveIDs() {
		alias, name := a.acc.Names(id)
		st := "unknown"
		o := NewObj()
		if f := c.Flag(id); f != nil {
			st = f.Str("status")
		}
		disp := alias
		if disp == "" {
			disp = name
		}
		if disp == "" {
			disp = "N/A (未命名)"
		}
		busy := a.disp.busy(id)
		var owner any
		if busy > 0 {
			owner = SLOT
		}
		o.Set("cookie", a.cookieStatus(id)).Set("authStatus", st)
		if f := c.Flag(id); f != nil {
			o.Set("invalidReason", f.V("reason")).Set("invalidAt", f.V("at"))
		}
		se := a.sched.Get(id)
		o.Set("canDelete", busy == 0).Set("id", id).Set("name", disp).Set("alias", alias).Set("accountName", name).Set("tier", a.acc.Tier(id)).
			Set("owner", owner).Set("busy", busy).Set("headless", a.importer.Has(id)).Set("disabled", a.disp.disabled[id]).
			Set("groups", toAny(se.Groups)).Set("priority", se.Priority).
			Set("cooldownUntil", c.Cooldowns[id]).Set("quota", c.Summary(id, a.policies))
		accs = append(accs, o)
	}
	cand := []any{}
	for _, id := range a.disp.candidates() {
		cand = append(cand, NewObj().Set("id", id).Set("busy", a.disp.busy(id)).Set("limit", a.perAcc))
	}
	hs := NewObj().Set("epoch", a.disp.epoch).Set("active", a.disp.active).Set("accounts", cand).Set("models", a.routing.Size()).Set("modelsAt", a.routing.at)
	return NewObj().Set("halted", c.Halted).Set("paused", a.disp.paused).Set("queue", len(a.sch.queue)).Set("scheduling", a.sch.status()).
		Set("runMode", runModeStatus()).Set("headless", hs).Set("streamingMode", a.stream.Get()).Set("implementation", "go").
		Set("ultra", a.acc.Status(c.Ids)).Set("analytics", a.health.JSON(a.hist)).
		Set("gatewayRepair", sanitizeStatsJSON()).
		Set("quotaMode", "per-account-per-model").Set("quotaLimits", tierLimitsJSON()).
		Set("slots", NewObj().Set(SLOT, NewObj().Set("account", nil).Set("active", a.disp.active).Set("ready", true).Set("headless", true).
			Set("pendingRetirements", 0).Set("pendingExecutions", execs))).
		Set("accounts", accs).Set("groups", toAny(a.sched.AllGroups()))
}

func (a *App) opsStatus() *Obj {
	a.mu.Lock()
	defer a.mu.Unlock()
	running := []any{}
	var ts []*Ticket
	for _, t := range a.disp.executions {
		ts = append(ts, t)
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i].CreatedAt < ts[j].CreatedAt })
	for _, t := range ts {
		_, live := a.disp.live[t.ID]
		running = append(running, NewObj().Set("id", t.ID).Set("account", t.Account).Set("model", t.Model).Set("kind", t.Kind).
			Set("phase", t.Phase).Set("createdAt", t.CreatedAt).Set("cancellable", live))
	}
	accs := []any{}
	for _, id := range a.liveIDs() {
		var flag, em any
		if f := a.core.Flag(id); f != nil {
			flag = f.Str("status")
		}
		if e := a.acc.Email(id); e != "" {
			em = e
		}
		se := a.sched.Get(id)
		accs = append(accs, NewObj().Set("id", id).Set("email", em).Set("imported", a.importer.Has(id)).Set("busy", a.disp.busy(id)).
			Set("limit", a.perAcc).Set("disabled", a.disp.disabled[id]).Set("cooldownUntil", a.core.Cooldowns[id]).Set("flag", flag).
			Set("tier", a.acc.Tier(id)).Set("groups", toAny(se.Groups)).Set("priority", se.Priority).
			Set("modelCooldowns", a.modelCooldownsL(id)))
	}
	return NewObj().Set("mode", "headless").Set("perAccount", a.perAcc).Set("active", a.disp.active).Set("queue", len(a.sch.queue)).
		Set("halted", a.core.Halted).Set("paused", a.disp.paused).Set("streamingMode", a.stream.Get()).Set("running", running).Set("accounts", accs).
		Set("groups", toAny(a.sched.AllGroups()))
}