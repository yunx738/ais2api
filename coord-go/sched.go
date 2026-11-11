package main

// HeadlessDispatch + RequestScheduler (headless-dispatch.js, request-scheduler.js, rejection-policy.js).
// All dispatch state is guarded by app.mu; forwarding runs outside the lock.
// Additions over the Node version: pinned account / account group per request, per-account priority.
import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const SLOT = "H"

type Plan struct {
	Model    string
	Family   string
	Eligible func(acct int) bool
	Rank     func(acct int) (float64, bool)
	Admit    func(acct int, id string) bool // metered plans (Build): own admission instead of the count ledger
	Build    *BuildSpec
	Estimate int64
}

type Ticket struct {
	ID        string
	Account   int
	Kind      string
	Model     string
	Phase     string
	CreatedAt int64
}

type Rejection struct {
	Status  int
	Headers map[string]string
	Body    []byte
}

type Result struct {
	Status          int
	RetryAfter      string
	Metrics         *MetricsOut
	Rejection       *Rejection
	Uncertain       bool
	Cancelled       bool
	WorkerRejection string
	// AuthExpired: the no-browser service reported this account's Google sign-in as expired (503 auth_required)
	AuthExpired bool
}

type Item struct {
	id        string
	route     string
	body      []byte
	res       *Resp
	plan      *Plan
	attempts  int
	attempted map[int]bool
	deadline  int64
	timer     *time.Timer
	rejection *Rejection
	closeID   int
	queued    bool
	pin       int
	group     string
	soft      string // early SSE kind ("" = none)
	model     string // client model (for the early stream)
	parsed    *Obj   // parsed body (chat completions or native)
	query     string // raw query of the client request (alt=sse ...)
	native    bool
	stream    bool
}

type liveExec struct {
	ticket *Ticket
	res    *Resp
}

// ---- dispatch ----
type Dispatch struct {
	app        *App
	epoch      string
	active     int
	requests   map[string]bool
	executions map[string]*Ticket
	retired    map[string]*Ticket
	inflight   map[int]int
	settled    map[string]bool
	cursor     int
	paused     bool
	disabled   map[int]bool
	live       map[string]*liveExec
	egress     *Obj
}

func NewDispatch(app *App) *Dispatch {
	return &Dispatch{app: app, epoch: uuid4(), requests: map[string]bool{}, executions: map[string]*Ticket{}, retired: map[string]*Ticket{},
		inflight: map[int]int{}, settled: map[string]bool{}, disabled: map[int]bool{}, live: map[string]*liveExec{}}
}

func (d *Dispatch) busy(a int) int { return d.inflight[a] }

func (d *Dispatch) candidates() []int {
	now := nowMs()
	c := d.app.core
	var out []int
	for _, id := range c.Ids {
		if c.Flag(id) != nil || d.disabled[id] || c.Cooldowns[id] > now || !d.app.importer.Has(id) {
			continue
		}
		out = append(out, id)
	}
	return out
}

func (d *Dispatch) acquire(id string, plan *Plan, eligible func(int) bool) (*Ticket, error) {
	if !reUUID.MatchString(id) {
		return nil, herr(500, "Invalid request ID")
	}
	if plan == nil || plan.Model == "" || !inStrs(plan.Family, "flash", "pro", "ultra") {
		return nil, herr(500, "Explicit model quota required")
	}
	if d.requests[id] {
		return nil, herr(500, "Duplicate request")
	}
	c := d.app.core
	if c.Halted || d.paused {
		return nil, nil
	}
	now := nowMs()
	metered := plan.Admit != nil
	ids := d.candidates()
	if len(ids) == 0 {
		return nil, nil
	}
	type ord struct {
		acct int
		i    int
		prio int
		k    float64
	}
	order := make([]ord, len(ids))
	for i, a := range ids {
		k := 0.0
		if plan.Rank != nil {
			if v, ok := plan.Rank(a); ok {
				k = v
			} else if plan.Family != "ultra" && d.app.acc.IsPremium(a) {
				k = 1
			}
		} else if plan.Family != "ultra" && d.app.acc.IsPremium(a) {
			k = 1
		}
		order[i] = ord{a, ((i-d.cursor)%len(ids) + len(ids)) % len(ids), d.app.sched.Priority(a), k}
	}
	sort.SliceStable(order, func(x, y int) bool {
		a, b := order[x], order[y]
		if a.prio != b.prio {
			return a.prio > b.prio
		}
		if a.k != b.k {
			return a.k < b.k
		}
		return a.i < b.i
	})
	for _, o := range order {
		a := o.acct
		if !eligible(a) {
			continue
		}
		if !metered && d.busy(a) >= d.app.perAccount() {
			continue
		}
		if !metered && !c.View(a, plan.Model, plan.Family, now).Allowed {
			continue
		}
		if metered {
			if !plan.Admit(a, id) {
				continue
			}
		} else if !c.Charge(a, plan.Model, plan.Family) {
			continue
		}
		t := &Ticket{ID: id, Account: a, Kind: plan.Family, Model: plan.Model, Phase: "running", CreatedAt: now}
		d.executions[id] = t
		d.requests[id] = true
		d.active++
		d.inflight[a]++
		for i, x := range ids {
			if x == a {
				d.cursor = (i + 1) % len(ids)
			}
		}
		if !metered {
			c.Checkpoint()
		}
		return t, nil
	}
	return nil, nil
}

func (d *Dispatch) settle(t *Ticket) {
	if d.settled[t.ID] {
		return
	}
	d.settled[t.ID] = true
	if d.inflight[t.Account] > 0 {
		d.inflight[t.Account]--
	}
}
func (d *Dispatch) markUncertain(t *Ticket) {
	if r := d.executions[t.ID]; r != nil {
		r.Phase = "reconciling"
	}
}

// finishIfSettled = check()+finish()+retire() of the Node version (in-process executions).
func (d *Dispatch) finishIfSettled(t *Ticket) bool {
	r := d.executions[t.ID]
	if r == nil || !d.settled[t.ID] {
		return false
	}
	delete(d.executions, t.ID)
	delete(d.requests, t.ID)
	d.active--
	delete(d.settled, t.ID)
	return true
}

// ---- scheduler ----
type Scheduler struct {
	app       *App
	queue     []*Item
	executing map[string]*Ticket
	closed    bool
	pumping   bool
	counts    struct{ retried, queueExpired, queueRejected, executionTimeouts int64 }
}

const (
	queueLimit         = 10
	queueTimeoutMs     = 120000
	maxAttempts        = 3
	executionTimeoutMs = 1200000
)

func NewScheduler(app *App) *Scheduler {
	s := &Scheduler{app: app, executing: map[string]*Ticket{}}
	go func() {
		for range time.Tick(time.Second) {
			app.mu.Lock()
			s.reconcileL()
			s.pumpL()
			app.mu.Unlock()
		}
	}()
	return s
}

func (s *Scheduler) status() *Obj {
	return NewObj().Set("queueLimit", queueLimit).Set("queueTimeoutMs", queueTimeoutMs).Set("maxAttempts", maxAttempts).
		Set("executionTimeoutMs", executionTimeoutMs).Set("controlTimeoutMs", 5500).Set("confirmationTimeoutMs", 5500).
		Set("retried", s.counts.retried).Set("queueExpired", s.counts.queueExpired).Set("queueRejected", s.counts.queueRejected).
		Set("executionTimeouts", s.counts.executionTimeouts).Set("queued", len(s.queue)).Set("executing", len(s.executing))
}

func (s *Scheduler) removeL(it *Item) {
	for i, x := range s.queue {
		if x == it {
			s.queue = append(s.queue[:i:i], s.queue[i+1:]...)
			break
		}
	}
	it.queued = false
	if it.timer != nil {
		it.timer.Stop()
		it.timer = nil
	}
	if it.closeID != 0 {
		it.res.RemoveClose(it.closeID)
		it.closeID = 0
	}
}

func respondRejection(res *Resp, rj *Rejection) {
	if rj == nil || res.Gone() {
		return
	}
	if res.Soft() {
		v, err := ParseJSON(rj.Body)
		if err != nil || asObj(v) == nil || asObj(v).V("error") == nil {
			v = NewObj().Set("error", NewObj().Set("message", clip(string(rj.Body), 2000)).Set("code", rj.Status))
		} else if e := asObj(v).V("error"); e != nil {
			if _, isStr := e.(string); isStr {
				v = NewObj().Set("error", NewObj().Set("message", e).Set("code", rj.Status))
			}
		}
		res.StreamError(rj.Status, v)
		return
	}
	if res.HeadersSent() {
		res.Destroy()
		return
	}
	h := res.Header()
	for _, k := range []string{"content-type", "retry-after", "cache-control"} {
		if v, ok := rj.Headers[k]; ok {
			h.Set(k, v)
		}
	}
	res.SetStatus(rj.Status)
	res.End(rj.Body)
}

// asynchronous responses must not run under app.mu (they may block on the socket)
func (s *Scheduler) failAsync(res *Resp, code int, msg string) { go res.Fail(code, msg) }

func (s *Scheduler) expireL(it *Item) {
	s.removeL(it)
	s.counts.queueExpired++
	if it.rejection != nil {
		rj := it.rejection
		go respondRejection(it.res, rj)
	} else {
		s.failAsync(it.res, 503, "Queue wait deadline exceeded")
	}
}

func (s *Scheduler) enqueueL(it *Item) bool {
	if s.closed || s.app.core.Halted {
		msg := "Dispatch admission unavailable"
		if s.closed {
			msg = "Coordinator stopping"
		}
		s.failAsync(it.res, 503, msg)
		return false
	}
	if it.res.Gone() {
		return false
	}
	remaining := it.deadline - nowMs()
	if remaining <= 0 {
		s.counts.queueExpired++
		if it.rejection != nil {
			rj := it.rejection
			go respondRejection(it.res, rj)
		} else {
			s.failAsync(it.res, 503, "Queue wait deadline exceeded")
		}
		return false
	}
	if len(s.queue) >= queueLimit {
		s.counts.queueRejected++
		if it.rejection != nil {
			rj := it.rejection
			go respondRejection(it.res, rj)
		} else {
			s.failAsync(it.res, 503, "Request queue full")
		}
		return false
	}
	var expire func()
	expire = func() {
		s.app.mu.Lock()
		defer s.app.mu.Unlock()
		if !it.queued {
			return
		}
		if w := it.deadline - nowMs(); w > 0 {
			it.timer = time.AfterFunc(time.Duration(w)*time.Millisecond, expire)
			return
		}
		s.expireL(it)
	}
	it.timer = time.AfterFunc(time.Duration(remaining)*time.Millisecond, expire)
	it.closeID = it.res.OnClose(func() {
		go func() {
			s.app.mu.Lock()
			if it.queued {
				s.removeL(it)
			}
			s.app.mu.Unlock()
		}()
	})
	it.queued = true
	s.queue = append(s.queue, it)
	return true
}

// Submit: called by the HTTP layer with the final upstream body.
func (s *Scheduler) Submit(it *Item) {
	s.app.mu.Lock()
	if s.closed || s.app.core.Halted {
		s.app.mu.Unlock()
		it.res.Fail(503, "Coordinator unavailable")
		return
	}
	plan, err := s.app.resolveModel(it, true)
	if err != nil {
		s.app.mu.Unlock()
		if he, ok := err.(*HTTPError); ok {
			if he.RetryAfter > 0 {
				it.res.Header().Set("Retry-After", strconv.FormatInt(he.RetryAfter, 10))
			}
			it.res.Fail(he.Status, he.Msg)
		} else {
			it.res.Fail(503, err.Error())
		}
		return
	}
	it.plan = plan
	it.id = uuid4()
	it.attempted = map[int]bool{}
	it.deadline = nowMs() + queueTimeoutMs
	if !s.enqueueL(it) {
		s.app.mu.Unlock()
		return
	}
	if it.soft != "" {
		it.res.OpenSSE(it.soft, it.model)
	}
	s.pumpL()
	s.app.mu.Unlock()
}

func (s *Scheduler) Pump() { s.app.mu.Lock(); s.pumpL(); s.app.mu.Unlock() }

func (s *Scheduler) pumpL() {
	if s.closed || s.pumping {
		return
	}
	if s.app.core.Halted {
		for _, it := range append([]*Item(nil), s.queue...) {
			s.removeL(it)
			s.failAsync(it.res, 503, "Dispatch admission unavailable")
		}
		return
	}
	s.pumping = true
	defer func() { s.pumping = false }()
	for _, it := range append([]*Item(nil), s.queue...) {
		if !it.queued {
			continue
		}
		if it.res.Gone() {
			s.removeL(it)
			continue
		}
		if nowMs() >= it.deadline {
			s.expireL(it)
			continue
		}
		plan, err := s.app.resolveModel(it, false)
		if err != nil {
			if he, ok := err.(*HTTPError); ok && inInts(he.Status, 400, 404, 409, 422, 429) {
				if he.RetryAfter > 0 && !it.res.HeadersSent() {
					it.res.Header().Set("Retry-After", strconv.FormatInt(he.RetryAfter, 10))
				}
				s.removeL(it)
				if it.rejection != nil && he.Status == 429 {
					rj := it.rejection
					go respondRejection(it.res, rj)
				} else {
					s.failAsync(it.res, he.Status, he.Msg)
				}
			}
			continue
		}
		it.plan = plan
		t, err := s.app.disp.acquire(it.id, plan, func(a int) bool {
			return !it.attempted[a] && (plan.Eligible == nil || plan.Eligible(a))
		})
		if err != nil {
			s.removeL(it)
			s.failAsync(it.res, 503, "Dispatch admission unavailable")
			continue
		}
		if t == nil {
			continue
		}
		s.removeL(it)
		it.attempts++
		it.attempted[t.Account] = true
		s.executing[t.ID] = t
		go s.execute(t, it)
	}
}

func (s *Scheduler) hasRetryCandidateL(it *Item) bool {
	c := s.app.core
	for _, a := range c.Ids {
		if it.attempted[a] || c.Cooldowns[a] >= it.deadline || c.Flag(a) != nil || s.app.disp.disabled[a] {
			continue
		}
		if it.plan.Eligible != nil && it.plan.Admit == nil && !it.plan.Eligible(a) {
			continue
		}
		q := c.View(a, it.plan.Model, it.plan.Family, nowMs())
		if q.CooldownUntil < it.deadline && (!q.LegacyBlocked || q.LegacyUntil < it.deadline) &&
			(q.Limit == nil || *q.Remaining > 0 || (q.WindowEnd > 0 && q.WindowEnd < it.deadline)) {
			return true
		}
	}
	return false
}

func (s *Scheduler) applyRejectionL(t *Ticket, r *Result) {
	if r == nil || r.WorkerRejection != "" || strings.HasPrefix(t.Model, "build-") {
		return
	}
	rs := rejectionCooldown(r, nowMs())
	if rs == nil {
		return
	}
	d := s.app.disp
	if rs.scope == "egress" {
		d.egress = NewObj().Set("slot", SLOT).Set("account", t.Account).Set("at", nowMs())
		logf("[Egress] slot H region rejected; account not cooled")
		return
	}
	if rs.scope == "account" {
		s.app.core.Cooldown(t.Account, rs.until)
	} else {
		s.app.core.Defer(t.Account, t.Model, t.Kind, rs.until)
	}
	s.app.core.Checkpoint()
}

func (s *Scheduler) execute(t *Ticket, it *Item) {
	ctx, cancel := context.WithCancel(it.res.Ctx())
	done := make(chan *Result, 1)
	go func() {
		defer func() {
			if p := recover(); p != nil {
				errf("[Execution] forward panic: %v", p)
				done <- nil
			}
		}()
		done <- s.app.forward(ctx, t, it)
	}()
	var r *Result
	timer := time.NewTimer(executionTimeoutMs * time.Millisecond)
	select {
	case r = <-done:
		timer.Stop()
		if r == nil {
			it.res.Fail(502, "Worker forwarding failed")
		}
	case <-timer.C:
		cancel()
		s.app.mu.Lock()
		s.counts.executionTimeouts++
		s.app.mu.Unlock()
		it.res.Fail(504, "Worker request timeout")
	}
	cancel()
	s.app.mu.Lock()
	defer s.app.mu.Unlock()
	defer func() { delete(s.executing, t.ID); s.pumpL() }()
	s.applyRejectionL(t, r)
	if r != nil && r.AuthExpired && !r.Uncertain && !r.Cancelled && s.app.core.Flag(t.Account) == nil && !readOnlyState {
		// take the account out of dispatch now (the 60 s sync would do the same) and retry elsewhere;
		// the nightly queue re-logs it in (never Gmail accounts)
		s.app.core.SetFlag(t.Account, NewObj().Set("status", "invalid").Set("reason", "login_required").Set("at", nowMs()).
			Set("source", "headless").Set("message", "no-browser service: sign-in session expired"))
		s.app.core.Checkpoint()
		logf("[Auth] #%d marked invalid (login_required): sign-in expired during a request", t.Account)
	}
	s.app.disp.markUncertain(t)
	retryable := r != nil && r.Rejection != nil && r.WorkerRejection == "" && !r.Uncertain && !r.Cancelled &&
		(inInts(r.Status, 401, 403, 429) || r.AuthExpired || (r.Status == 400 && r.Rejection.Headers["x-ais-build-retry"] == "upstream_failed")) &&
		!it.res.Started() && !it.res.Gone()
	s.app.disp.finishIfSettled(t)
	if r == nil || r.Rejection == nil {
		return
	}
	it.rejection = r.Rejection
	if retryable && it.attempts < maxAttempts && !s.closed && !s.app.core.Halted && s.hasRetryCandidateL(it) {
		it.id = uuid4()
		if s.enqueueL(it) {
			s.counts.retried++
			logf("[Scheduler] #%d %s rejected %d; retrying on another account", t.Account, t.Model, r.Status)
			return
		}
		return
	}
	rj := r.Rejection
	go respondRejection(it.res, rj)
}

// reconcile: executions whose forward settled after a timeout are released here.
func (s *Scheduler) reconcileL() {
	for id, t := range s.app.disp.executions {
		if s.executing[id] == nil {
			s.app.disp.finishIfSettled(t)
		}
	}
}

func (s *Scheduler) Close() {
	s.app.mu.Lock()
	s.closed = true
	for _, it := range append([]*Item(nil), s.queue...) {
		s.removeL(it)
		s.failAsync(it.res, 503, "Coordinator stopping")
	}
	s.app.mu.Unlock()
}

// ---- rejection policy ----
type restriction struct {
	scope string
	until int64
}

var reRegion = regexp.MustCompile(`(?i)region not supported|not available in your (?:country|region)|unsupported[_\s-]*(?:country|region|location)|user location is not supported|available-regions`)
var reSignature = regexp.MustCompile(`(?i)caller does not have permission`)
var reRetryIn = regexp.MustCompile(`(?i)retry in\s+((?:\d+h)?(?:\d+m(?:[^s]|$))?(?:[\d.]+s)?(?:[\d.]+ms)?)`)
var reRetryDelay = regexp.MustCompile(`"retryDelay"\s*:\s*"([\d.]+)s"`)
var reExhausted = regexp.MustCompile(`(?i)insufficient[_\s-]*quota|daily[^\n]{0,80}(?:quota|limit)|(?:quota|limit)[^\n]{0,80}daily|per[\s_-]*day|requests?\s*/\s*day|\brpd\b|额度不足|余额不足|每日|每天`)
var reNumOnly = regexp.MustCompile(`^\d+(?:\.\d+)?$`)

func bodyText(b []byte, n int) string {
	if len(b) > n {
		b = b[:n]
	}
	return string(b)
}

func parseRetryIn(spec string) float64 {
	num := func(re string) float64 {
		m := regexp.MustCompile(re).FindStringSubmatch(spec)
		if m == nil {
			return 0
		}
		f, _ := strconv.ParseFloat(m[1], 64)
		return f
	}
	h := num(`(\d+)h`)
	mm := num(`(\d+)m(?:[^s]|$)`)
	sec := 0.0
	if m := regexp.MustCompile(`([\d.]+)s`).FindAllStringSubmatchIndex(spec, -1); m != nil {
		for _, ix := range m {
			// skip "ms"
			if ix[1]-2 >= 0 && spec[ix[1]-2] == 'm' {
				continue
			}
			f, _ := strconv.ParseFloat(spec[ix[2]:ix[3]], 64)
			sec = f
		}
	}
	ms := num(`([\d.]+)ms`)
	return h*3600000 + mm*60000 + sec*1000 + ms
}

func rejectionCooldown(r *Result, now int64) *restriction {
	if r == nil {
		return nil
	}
	var body []byte
	if r.Rejection != nil {
		body = r.Rejection.Body
	}
	if (r.Status == 403 || r.Status == 400) && reRegion.MatchString(bodyText(body, 8192)) {
		return &restriction{"egress", 0}
	}
	if r.Status == 403 && reSignature.MatchString(bodyText(body, 16384)) {
		return nil
	}
	switch r.Status {
	case 401:
		return &restriction{"account", now + DAY}
	case 403:
		return &restriction{"model", now + DAY}
	case 429:
	default:
		return nil
	}
	delay := -1.0
	ra := strings.TrimSpace(r.RetryAfter)
	if reNumOnly.MatchString(ra) {
		f, _ := strconv.ParseFloat(ra, 64)
		delay = f * 1000
	} else if ra != "" {
		if t, err := time.Parse(time.RFC1123, ra); err == nil {
			delay = float64(t.UnixMilli() - now)
		}
	}
	if delay < 0 {
		text := bodyText(body, 16384)
		if m := reRetryIn.FindStringSubmatch(text); m != nil && m[1] != "" {
			if ms := parseRetryIn(m[1]); ms > 0 {
				delay = ms
			}
		}
		if delay < 0 {
			if m := reRetryDelay.FindStringSubmatch(text); m != nil {
				f, _ := strconv.ParseFloat(m[1], 64)
				delay = f * 1000
			}
		}
	}
	if delay < 0 {
		if reExhausted.MatchString(string(body)) {
			delay = float64(untilNextReset(now))
		} else {
			delay = 60000
		}
	}
	if delay < 1000 {
		delay = 1000
	}
	if delay > float64(DAY) {
		delay = float64(DAY)
	}
	return &restriction{"model", now + int64(delay+0.999999)}
}

var _ sync.Mutex