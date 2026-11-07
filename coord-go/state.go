package main

// state.json: account pool, flags, per-account/per-model quota ledger. Format identical to the Node
// coordinator (dispatch-state.js save/read) so either implementation can run on the same file.
// Browser-mode slot data (pool.slots, dispatch.slots) is kept verbatim.
import (
	"errors"
	"os"
	"sort"
	"strconv"
)

type QModel struct {
	Family        string
	Used          int64
	CooldownUntil int64
}
type QAcc struct {
	WindowStart int64
	morder      []string
	models      map[string]*QModel
	Legacy      *Obj
}

func (a *QAcc) model(m string, family string, create bool) *QModel {
	q := a.models[m]
	if q == nil && create {
		q = &QModel{Family: family}
		a.models[m] = q
		a.morder = append(a.morder, m)
	}
	return q
}

var TIER_LIMITS = map[string]map[string]int64{
	"standard": {"flash": 100, "pro": 10, "ultra": 10},
	"pro":      {"flash": 100, "pro": 50, "ultra": 50},
	"ultra":    {"flash": 200, "pro": 200, "ultra": 200},
	"ultra20":  {"flash": 200, "pro": 200, "ultra": 200},
}

func tierLimitsJSON() *Obj {
	o := NewObj()
	for _, t := range []string{"standard", "pro", "ultra", "ultra20"} {
		x := NewObj()
		for _, f := range []string{"flash", "pro", "ultra"} {
			x.Set(f, TIER_LIMITS[t][f])
		}
		o.Set(t, x)
	}
	return o
}

type QView struct {
	Model, Family                          string
	Limit                                  *int64
	Used                                   int64
	Remaining                              *int64
	WindowStart, WindowEnd, CooldownUntil  int64
	LegacyBlocked                          bool
	LegacyUntil                            int64
	Allowed                                bool
}

func (v QView) JSON() *Obj {
	o := NewObj().Set("model", v.Model).Set("family", v.Family)
	if v.Limit == nil {
		o.Set("limit", nil)
	} else {
		o.Set("limit", *v.Limit)
	}
	o.Set("unlimited", v.Limit == nil).Set("used", v.Used)
	if v.Remaining == nil {
		o.Set("remaining", nil)
	} else {
		o.Set("remaining", *v.Remaining)
	}
	return o.Set("windowStart", v.WindowStart).Set("windowEnd", v.WindowEnd).Set("cooldownUntil", v.CooldownUntil).
		Set("legacyBlocked", v.LegacyBlocked).Set("legacyUntil", v.LegacyUntil).Set("allowed", v.Allowed)
}

type Core struct {
	file      string
	Ids       []int
	Cursor    int64
	Sequence  int64
	poolSlots any
	cdOrder   []int
	Cooldowns map[int]int64
	Flags     *Obj // "id" -> {status,reason,at,deletedAt?}
	AuthSaves *Obj
	Throttle  any
	qorder    []string
	quotas    map[string]*QAcc
	dispatch  *Obj
	Halted    bool
	tierOf    func(int) string
	limitOver func(int, string) (int64, bool)
}

func num64(v any) int64 { f, _ := asNum(v); return int64(f) }

func LoadCore(file string) (*Core, []int, error) {
	raw, err := readJSONFile(file)
	if err != nil {
		return nil, nil, err
	}
	d := asObj(raw)
	if d == nil {
		return nil, nil, errors.New("Invalid checkpoint")
	}
	if v, _ := asSafeInt(d.V("version")); v != 2 {
		return nil, nil, errors.New("Explicit per-model quota migration required")
	}
	p := d.Obj("pool")
	if p == nil || d.Obj("dispatch") == nil {
		return nil, nil, errors.New("Invalid checkpoint")
	}
	c := &Core{file: file, Cooldowns: map[int]int64{}, quotas: map[string]*QAcc{}, tierOf: func(int) string { return "standard" }}
	seen := map[int]bool{}
	for _, x := range p.Arr("ids") {
		n, ok := asSafeInt(x)
		if !ok || n < 1 || seen[int(n)] {
			return nil, nil, errors.New("Invalid account pool")
		}
		seen[int(n)] = true
		c.Ids = append(c.Ids, int(n))
	}
	if len(c.Ids) == 0 {
		return nil, nil, errors.New("Invalid account pool")
	}
	c.Cursor = num64(p.V("cursor"))
	c.Sequence = num64(p.V("sequence"))
	c.poolSlots = p.V("slots")
	for _, e := range p.Arr("cooldowns") {
		a := asArr(e)
		if len(a) != 2 {
			return nil, nil, errors.New("Invalid cooldown")
		}
		id := int(num64(a[0]))
		if !seen[id] {
			return nil, nil, errors.New("Invalid cooldown")
		}
		if _, ok := c.Cooldowns[id]; !ok {
			c.cdOrder = append(c.cdOrder, id)
		}
		c.Cooldowns[id] = num64(a[1])
	}
	c.Flags = d.Obj("accountFlags")
	if c.Flags == nil {
		c.Flags = NewObj()
	}
	c.AuthSaves = d.Obj("authSaves")
	if c.AuthSaves == nil {
		c.AuthSaves = NewObj()
	}
	c.Throttle = d.V("rotationThrottle")
	if c.Throttle == nil {
		c.Throttle = NewObj().Set("lastAt", 0)
	}
	ql := d.Obj("quotaLedger")
	if ql == nil || num64(ql.V("version")) != 1 || ql.Obj("accounts") == nil {
		return nil, nil, errors.New("Invalid model quota ledger")
	}
	for _, k := range ql.Obj("accounts").Keys() {
		a := ql.Obj("accounts").Obj(k)
		id, err := strconv.Atoi(k)
		if err != nil || !seen[id] || a == nil {
			return nil, nil, errors.New("Unknown quota account")
		}
		qa := &QAcc{WindowStart: num64(a.V("windowStart")), models: map[string]*QModel{}, Legacy: a.Obj("legacy")}
		for _, m := range a.Obj("models").Keys() {
			q := a.Obj("models").Obj(m)
			qa.models[m] = &QModel{Family: q.Str("family"), Used: num64(q.V("used")), CooldownUntil: num64(q.V("cooldownUntil"))}
			qa.morder = append(qa.morder, m)
		}
		c.quotas[k] = qa
		c.qorder = append(c.qorder, k)
	}
	var missing []int
	for _, id := range c.Ids {
		if c.quotas[strconv.Itoa(id)] == nil {
			c.account(id, true)
			missing = append(missing, id)
		}
	}
	c.dispatch = d.Obj("dispatch")
	c.Halted = d.Bool("dispatch.halted")
	if h, ok := c.dispatch.V("halted").(bool); ok {
		c.Halted = h
	}
	return c, missing, nil
}

func (c *Core) account(id int, create bool) *QAcc {
	k := strconv.Itoa(id)
	a := c.quotas[k]
	if a == nil && create {
		a = &QAcc{models: map[string]*QModel{}}
		c.quotas[k] = a
		c.qorder = append(c.qorder, k)
	}
	return a
}

func (c *Core) snapshot() []byte {
	ql := NewObj()
	keys := append([]string(nil), c.qorder...)
	sort.SliceStable(keys, func(i, j int) bool { a, _ := strconv.Atoi(keys[i]); b, _ := strconv.Atoi(keys[j]); return a < b })
	for _, k := range keys {
		a := c.quotas[k]
		ms := NewObj()
		for _, m := range a.morder {
			q := a.models[m]
			ms.Set(m, NewObj().Set("family", q.Family).Set("used", q.Used).Set("cooldownUntil", q.CooldownUntil))
		}
		var leg any
		if a.Legacy != nil {
			leg = a.Legacy
		}
		ql.Set(k, NewObj().Set("windowStart", a.WindowStart).Set("models", ms).Set("legacy", leg))
	}
	ids := make([]any, len(c.Ids))
	for i, id := range c.Ids {
		ids[i] = id
	}
	cds := []any{}
	for _, id := range c.cdOrder {
		cds = append(cds, []any{id, c.Cooldowns[id]})
	}
	disp := c.dispatch.Clone()
	disp.Set("halted", c.Halted)
	data := NewObj().Set("version", 2).Set("rotationThrottle", c.Throttle).Set("authSaves", c.AuthSaves).
		Set("accountFlags", c.Flags).Set("quotaLedger", NewObj().Set("version", 1).Set("accounts", ql)).
		Set("pool", NewObj().Set("ids", ids).Set("cursor", c.Cursor).Set("sequence", c.Sequence).Set("slots", c.poolSlots).Set("cooldowns", cds)).
		Set("dispatch", disp)
	return MarshalJS(data)
}

var readOnlyState bool

func (c *Core) Checkpoint() error {
	if readOnlyState {
		return nil
	}
	if err := writeAtomic(c.file, c.snapshot(), 0600, true); err != nil {
		c.Halted = true
		return err
	}
	return nil
}
func (c *Core) TryResume() bool {
	if !c.Halted {
		return false
	}
	c.Halted = false
	if err := c.Checkpoint(); err != nil {
		c.Halted = true
		return false
	}
	return true
}

// ---- pool ----
func (c *Core) InPool(id int) bool {
	for _, x := range c.Ids {
		if x == id {
			return true
		}
	}
	return false
}
func (c *Core) Cooldown(id int, until int64) {
	if _, ok := c.Cooldowns[id]; !ok {
		c.cdOrder = append(c.cdOrder, id)
		c.Cooldowns[id] = until
		return
	}
	if until > c.Cooldowns[id] {
		c.Cooldowns[id] = until
	}
}
func (c *Core) SetCooldown(id int, until int64) { // exact (operator)
	if _, ok := c.Cooldowns[id]; !ok {
		c.cdOrder = append(c.cdOrder, id)
	}
	c.Cooldowns[id] = until
}
func (c *Core) ClearCooldown(id int) {
	if _, ok := c.Cooldowns[id]; !ok {
		return
	}
	delete(c.Cooldowns, id)
	for i, x := range c.cdOrder {
		if x == id {
			c.cdOrder = append(c.cdOrder[:i:i], c.cdOrder[i+1:]...)
			break
		}
	}
}
func (c *Core) AddAccount(id int) {
	c.account(id, true)
	c.Ids = append(c.Ids, id)
	sort.Ints(c.Ids)
}

// ---- flags ----
func (c *Core) Flag(id int) *Obj { return c.Flags.Obj(strconv.Itoa(id)) }
func (c *Core) FlagStatus(id int) string {
	f := c.Flag(id)
	if f == nil {
		return ""
	}
	return f.Str("status")
}
func (c *Core) Deleted(id int) bool { return c.FlagStatus(id) == "deleted" }
func (c *Core) SetFlag(id int, f *Obj) {
	k := strconv.Itoa(id)
	if f == nil {
		c.Flags.Del(k)
		return
	}
	c.Flags.Set(k, f)
	sortNumericKeys(c.Flags)
}
func sortNumericKeys(o *Obj) {
	sort.SliceStable(o.keys, func(i, j int) bool {
		a, e1 := strconv.Atoi(o.keys[i])
		b, e2 := strconv.Atoi(o.keys[j])
		if e1 != nil || e2 != nil {
			return false
		}
		return a < b
	})
}

// ---- quota ledger ----
func (c *Core) limitFor(id int, family string) *int64 {
	if c.limitOver != nil {
		if n, ok := c.limitOver(id, family); ok {
			if n < 0 {
				return nil
			}
			return &n
		}
	}
	t := TIER_LIMITS[c.tierOf(id)]
	if t == nil {
		t = TIER_LIMITS["standard"]
	}
	n := t[family]
	return &n
}
func windowActive(a *QAcc, now int64) bool {
	return a != nil && a.WindowStart > 0 && a.WindowStart <= now && a.WindowStart >= periodStart(now)
}
func (c *Core) View(id int, model, family string, now int64) QView {
	a := c.account(id, false)
	var q *QModel
	if a != nil {
		q = a.models[model]
	}
	active := windowActive(a, now)
	var used int64
	if active && q != nil {
		used = q.Used
	}
	legacyBlocked, legacyUntil := false, int64(0)
	if a != nil && a.Legacy != nil {
		until := num64(a.Legacy.V("until"))
		if now < until {
			for _, f := range a.Legacy.Arr("blockedFamilies") {
				if s, _ := f.(string); s == family {
					legacyBlocked, legacyUntil = true, until
				}
			}
		}
	}
	var cd int64
	if q != nil {
		cd = q.CooldownUntil
	}
	limit := c.limitFor(id, family)
	v := QView{Model: model, Family: family, Limit: limit, Used: used, CooldownUntil: cd, LegacyBlocked: legacyBlocked, LegacyUntil: legacyUntil}
	if limit != nil {
		r := *limit - used
		if r < 0 {
			r = 0
		}
		v.Remaining = &r
	}
	if active {
		v.WindowStart = a.WindowStart
		v.WindowEnd = periodStart(a.WindowStart) + DAY
	}
	v.Allowed = !legacyBlocked && cd <= now && (limit == nil || used < *limit)
	return v
}
func (c *Core) Charge(id int, model, family string) bool {
	now := nowMs()
	if !c.View(id, model, family, now).Allowed {
		return false
	}
	a := c.account(id, true)
	if !windowActive(a, now) {
		for _, q := range a.models {
			q.Used = 0
		}
		a.WindowStart = now
	}
	q := a.model(model, family, true)
	q.Family = family
	q.Used++
	return true
}
func (c *Core) Defer(id int, model, family string, until int64) {
	a := c.account(id, true)
	q := a.model(model, family, true)
	if until > q.CooldownUntil {
		q.CooldownUntil = until
	}
}
func (c *Core) Summary(id int, policies *PolicyStore) *Obj {
	models := NewObj()
	now := nowMs()
	for _, m := range policies.Order() {
		models.Set(m, c.View(id, m, policies.Get(m).Family, now).JSON())
	}
	a := c.account(id, false)
	var leg any
	if a != nil && a.Legacy != nil {
		leg = cloneDeep(a.Legacy)
	}
	return NewObj().Set("account", id).Set("models", models).Set("legacy", leg)
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }