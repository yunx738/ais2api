package main

// Model routing (headless-routing.js + request-model.js) and per-request account selection.
// Account selection (new): model suffix "@31" / "@g:主力", or headers X-AIS-Account / X-AIS-Group.
// The suffix is removed before anything is sent upstream or recorded.
import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Routing struct {
	mu     sync.RWMutex
	app    *App
	models map[string]bool
	at     int64
}

func (r *Routing) Refresh() {
	cr := r.app.svc.Call(context.Background(), "", "GET", "/v1/models", nil)
	if cr.Err != nil || cr.Status != 200 || cr.JSON.Arr("data") == nil {
		return
	}
	m := map[string]bool{}
	for _, d := range cr.JSON.Arr("data") {
		if id := asObj(d).Str("id"); id != "" {
			m[id] = true
		}
	}
	r.mu.Lock()
	r.models, r.at = m, nowMs()
	r.mu.Unlock()
}
func (r *Routing) Start() {
	go func() {
		r.Refresh()
		for range time.Tick(10 * time.Minute) {
			r.Refresh()
		}
	}()
}
func (r *Routing) Has(m string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.models[m]
}
func (r *Routing) Size() int { r.mu.RLock(); defer r.mu.RUnlock(); return len(r.models) }
func (r *Routing) Models() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.models))
	for m := range r.models {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}
func (r *Routing) List() []string {
	size := r.Size()
	seen := map[string]bool{}
	var out []string
	for _, id := range r.app.policies.Order() {
		if size > 0 && !r.Has(id) {
			continue
		}
		p := r.app.policies.Get(id)
		for _, x := range []string{id, "anti-truncation/" + id} {
			if x == id || p.AntiTruncation {
				if !seen[x] {
					seen[x] = true
					out = append(out, x)
				}
			}
		}
	}
	sort.Strings(out)
	return out
}

var reModelID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
var rePin = regexp.MustCompile(`@(?:(\d{1,6})|g:([\p{L}\p{N}_-]{1,20}))$`)

// splitPin: "gemini-x@31" -> ("gemini-x", 31, ""); "gemini-x@g:主力" -> ("gemini-x", 0, "主力").
func splitPin(model string) (string, int, string) {
	m := rePin.FindStringSubmatchIndex(model)
	if m == nil {
		return model, 0, ""
	}
	base := model[:m[0]]
	if m[2] >= 0 {
		n, _ := strconv.Atoi(model[m[2]:m[3]])
		return base, n, ""
	}
	return base, 0, model[m[4]:m[5]]
}

// resolveModel (called under app.mu). first=true at admission (allowUnavailable).
func (a *App) resolveModel(it *Item, first bool) (*Plan, error) {
	var plan *Plan
	if !it.native {
		bp, err := a.build.Resolve(it.route, it.parsed, first)
		if err != nil {
			return nil, err
		}
		plan = bp
	}
	if plan == nil {
		requested := it.model
		at := strings.HasPrefix(requested, AT_PREFIX)
		up := requested
		if at {
			up = requested[len(AT_PREFIX):]
		}
		if !reModelID.MatchString(up) {
			return nil, herr(400, "Invalid request model")
		}
		pol, ok := a.policies.Lookup(up)
		if !ok {
			return nil, herr(422, "Explicit quota policy required for this model")
		}
		if at && !pol.AntiTruncation {
			return nil, herr(422, "Anti-truncation unsupported for this model")
		}
		if a.routing.Size() > 0 && !a.routing.Has(up) {
			return nil, herr(404, "Model not available on the no-browser service")
		}
		c := a.core
		if pol.Family == "ultra" {
			var prem []int
			for _, id := range c.Ids {
				if a.acc.IsPremium(id) && c.Flag(id) == nil && a.pinOK(it, id) {
					prem = append(prem, id)
				}
			}
			if len(prem) == 0 {
				return nil, herr(503, "This model needs a Pro or Ultra account; none is available in the account pool")
			}
			now := nowMs()
			soonest := int64(1 << 62)
			for _, id := range prem {
				q := c.View(id, up, "ultra", now)
				w := q.CooldownUntil
				if c.Cooldowns[id] > w {
					w = c.Cooldowns[id]
				}
				if w < soonest {
					soonest = w
				}
			}
			if soonest > now+120000 {
				return nil, &HTTPError{Status: 429, Msg: "All Pro/Ultra accounts are rate limited for " + up + " by Google; quota resets around " + bjTime(soonest) + " (Beijing time)",
					RetryAfter: (soonest - now + 999) / 1000}
			}
		}
		fam := pol.Family
		plan = &Plan{Model: up, Family: fam, Eligible: func(acct int) bool { return fam != "ultra" || a.acc.IsPremium(acct) }}
	}
	// account pin / group
	if it.pin > 0 || it.group != "" {
		if err := a.checkPin(it, plan); err != nil {
			return nil, err
		}
		inner := plan.Eligible
		plan.Eligible = func(acct int) bool { return a.pinOK(it, acct) && (inner == nil || inner(acct)) }
	}
	return plan, nil
}

func (a *App) pinOK(it *Item, acct int) bool {
	if it.pin > 0 {
		return acct == it.pin
	}
	if it.group != "" {
		return a.sched.InGroup(acct, it.group)
	}
	return true
}

// checkPin gives a clear error instead of a 2-minute queue wait when the pin can never be served.
func (a *App) checkPin(it *Item, plan *Plan) error {
	c := a.core
	var ids []int
	if it.pin > 0 {
		if !c.InPool(it.pin) || c.Deleted(it.pin) {
			return herr(404, "指定的账号 #"+itoa(it.pin)+" 不在账号池")
		}
		ids = []int{it.pin}
	} else {
		ids = a.sched.Members(it.group, c.Ids)
		if len(ids) == 0 {
			return herr(404, "分组 "+it.group+" 里没有账号")
		}
	}
	now := nowMs()
	var reasons []string
	var soonest int64 = 1 << 62
	for _, id := range ids {
		switch {
		case c.Flag(id) != nil:
			reasons = append(reasons, "#"+itoa(id)+" 登录失效")
		case !a.importer.Has(id):
			reasons = append(reasons, "#"+itoa(id)+" 未导入无浏览器服务")
		case a.disp.disabled[id]:
			reasons = append(reasons, "#"+itoa(id)+" 已停用")
		case plan.Build == nil && plan.Family == "ultra" && !a.acc.IsPremium(id):
			reasons = append(reasons, "#"+itoa(id)+" 不是 Pro/Ultra 账号")
		case plan.Build != nil && !a.build.ready(id, plan.Build.Model):
			reasons = append(reasons, "#"+itoa(id)+" 不能使用 Build "+plan.Build.Model)
		default:
			w := c.Cooldowns[id]
			if plan.Build == nil {
				q := c.View(id, plan.Model, plan.Family, now)
				if q.CooldownUntil > w {
					w = q.CooldownUntil
				}
				if q.Limit != nil && *q.Remaining <= 0 && q.WindowEnd > w {
					w = q.WindowEnd
				}
			}
			if w <= now+120000 {
				return nil // at least one can serve (now or within the queue wait)
			}
			if w < soonest {
				soonest = w
			}
			reasons = append(reasons, "#"+itoa(id)+" 冷却或额度用完")
		}
	}
	if soonest != 1<<62 {
		return &HTTPError{Status: 429, Msg: "指定的账号暂时不可用（" + strings.Join(reasons, "；") + "），约 " + bjTime(soonest) + "（北京时间）恢复", RetryAfter: (soonest - now + 999) / 1000}
	}
	return herr(409, "指定的账号不可用："+strings.Join(reasons, "；"))
}