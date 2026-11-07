package main

// request-history.js + recorded-forward.js + model-price-store.js + analytics-query.js.
// Each request is one JSON file request-history/<uuid>.json (same format as the Node version).
// Records are kept in memory as a compact index plus the raw file bytes (parsed only when listed).
import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type HistRow struct {
	ID                 string
	CreatedAt          int64
	FinishedAt         *int64
	Phase, Outcome     string
	Model              string
	Account            *int64
	HTTPStatus         *int64
	Known              bool // usageComplete && safe total
	Total              int64
	CostKnown          bool
	Cost               float64
	DurOK              bool
	Dur                float64
	raw                []byte
}

func indexRow(o *Obj, raw []byte) *HistRow {
	r := &HistRow{ID: o.Str("id"), Phase: o.Str("phase"), Outcome: o.Str("outcome"), Model: o.Str("model"), raw: raw}
	r.CreatedAt, _ = asSafeInt(o.V("createdAt"))
	if n, ok := asSafeInt(o.V("finishedAt")); ok {
		r.FinishedAt = &n
	}
	if n, ok := asSafeInt(o.V("account")); ok {
		r.Account = &n
	}
	if n, ok := asSafeInt(o.V("httpStatus")); ok {
		r.HTTPStatus = &n
	}
	m := o.Obj("metrics")
	if m != nil {
		if m.V("usageComplete") == true {
			if t, ok := asSafeInt(m.Obj("usage").V("total")); ok {
				r.Known, r.Total = true, t
			}
		}
		if d, ok := asNum(m.V("durationMs")); ok {
			r.DurOK, r.Dur = true, d
		}
	}
	if c := o.Obj("cost"); c != nil {
		if a, ok := asNum(c.V("amount")); ok {
			r.CostKnown, r.Cost = true, a
		}
	}
	return r
}

type History struct {
	mu        sync.Mutex
	wmu       sync.Mutex // serialises persistence (JS enqueue chain)
	dir       string
	max       int
	rows      map[string]*HistRow
	ready     bool
	degraded  bool
	errStr    string
	initErr   string
	attempts  int
}

func OpenHistory(dir string) *History {
	h := &History{dir: dir, max: 100000, rows: map[string]*HistRow{}}
	if err := h.init(); err != nil {
		h.initErr = clip(err.Error(), 120)
		h.attempts = 1
		errf("[Analytics] history unavailable: %s", h.initErr)
		go func() {
			for !h.ready {
				sleepMs(60000)
				h.attempts++
				n := &History{dir: dir, max: h.max, rows: map[string]*HistRow{}}
				if err := n.init(); err == nil {
					h.mu.Lock()
					h.rows, h.ready = n.rows, true
					h.mu.Unlock()
					logf("[Analytics] history recovered after %d attempt(s)", h.attempts)
				} else {
					h.initErr = clip(err.Error(), 120)
				}
			}
		}()
	}
	return h
}

func (h *History) init() error {
	if err := os.MkdirAll(h.dir, 0700); err != nil {
		return err
	}
	ents, err := os.ReadDir(h.dir)
	if err != nil {
		return err
	}
	var names []string
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".json") {
			names = append(names, e.Name())
		}
	}
	if len(names) > h.max {
		return errors.New("History capacity exceeded; archive required")
	}
	for _, n := range names {
		id := n[:len(n)-5]
		if !reUUIDStrict.MatchString(id) {
			return errors.New("Invalid history filename")
		}
		f := filepath.Join(h.dir, n)
		st, err := os.Lstat(f)
		if err != nil || !st.Mode().IsRegular() || st.Size() > 32768 {
			return errors.New("Invalid history file")
		}
		b, err := os.ReadFile(f)
		if err != nil {
			return err
		}
		o, err := ParseObj(b)
		if err != nil {
			return err
		}
		v, _ := asSafeInt(o.V("version"))
		_, okc := asSafeInt(o.V("createdAt"))
		if v != 1 || o.Str("id") != id || !okc || !inStrs(o.Str("phase"), "pending", "finished") {
			return errors.New("History record invalid")
		}
		h.rows[id] = indexRow(o, trimNL(b))
	}
	h.ready = true
	return nil
}
func trimNL(b []byte) []byte {
	for len(b) > 0 && (b[len(b)-1] == '\n' || b[len(b)-1] == '\r') {
		b = b[:len(b)-1]
	}
	return append([]byte(nil), b...)
}

func (h *History) Status() *Obj {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.ready {
		return NewObj().Set("ready", false).Set("degraded", true).Set("error", "history_initialization_failed").
			Set("records", nil).Set("capacity", nil).Set("attempts", h.attempts).Set("lastError", h.initErr)
	}
	var e any
	if h.errStr != "" {
		e = h.errStr
	}
	return NewObj().Set("ready", h.ready).Set("degraded", h.degraded).Set("error", e).Set("records", len(h.rows)).Set("capacity", h.max)
}
func (h *History) usable() error {
	if !h.ready {
		return herr(503, "Request history unavailable")
	}
	if h.degraded {
		return errors.New("History unavailable")
	}
	return nil
}

func (h *History) persist(o *Obj) error {
	id := o.Str("id")
	data := MarshalJS(o)
	if err := writeAtomic(filepath.Join(h.dir, id+".json"), append(append([]byte(nil), data...), '\n'), 0600, true); err != nil {
		h.mu.Lock()
		h.degraded, h.errStr = true, "history_write_failed"
		h.mu.Unlock()
		return errors.New("History persistence failed")
	}
	h.mu.Lock()
	h.rows[id] = indexRow(o, data)
	h.mu.Unlock()
	return nil
}

var reHistModel = regexp.MustCompile(`^[a-zA-Z0-9._/-]{1,200}$`)

type BeginInput struct {
	ID, Model, RequestedModel string
	Account                   int
	Slot, WorkerEpoch         string
	Stream                    bool
	Price                     *Price
}

func (h *History) Begin(in BeginInput) error {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	h.mu.Lock()
	err := h.usable()
	old := h.rows[in.ID]
	size := len(h.rows)
	h.mu.Unlock()
	if err != nil {
		return err
	}
	if !reUUIDStrict.MatchString(in.ID) || !reHistModel.MatchString(in.Model) {
		return errors.New("Invalid request identity")
	}
	if old != nil {
		if old.Model != in.Model || old.Account == nil || *old.Account != int64(in.Account) {
			return errors.New("History identity conflict")
		}
		return nil
	}
	if size >= h.max {
		return errors.New("History capacity reached")
	}
	rm := in.Model
	if reHistModel.MatchString(in.RequestedModel) {
		rm = in.RequestedModel
	}
	var slot, epoch any
	if inStrs(in.Slot, "A", "B") {
		slot = in.Slot
	}
	if reUUIDStrict.MatchString(in.WorkerEpoch) {
		epoch = in.WorkerEpoch
	}
	var price any
	if in.Price != nil {
		if in.Price.validate() != nil || len(in.Price.Revision) > 100 {
			return errors.New("Invalid price metadata")
		}
		price = in.Price.JSON()
	}
	var acct any
	if in.Account >= 0 {
		acct = in.Account
	}
	o := NewObj().Set("version", 1).Set("id", in.ID).Set("createdAt", nowMs()).Set("phase", "pending").Set("outcome", "pending").
		Set("model", in.Model).Set("requestedModel", rm).Set("account", acct).Set("slot", slot).Set("workerEpoch", epoch).
		Set("stream", in.Stream).Set("queueMs", nil).Set("price", price).Set("metrics", nil).Set("cost", nil).Set("httpStatus", nil).Set("finishedAt", nil)
	return h.persist(o)
}

func numOrNull(p *int64) any {
	if p == nil || *p < 0 {
		return nil
	}
	return *p
}

// metrics() in request-history.js
func metricsJSON(m *MetricsOut) *Obj {
	if m == nil {
		return nil
	}
	o := NewObj().Set("firstByteMs", numOrNull(m.FirstByteMs)).Set("firstContentMs", numOrNull(m.FirstContentMs)).Set("durationMs", numOrNull(m.DurationMs))
	o.Set("usageComplete", m.UsageComplete).Set("transportComplete", m.TransportComplete).Set("streamDoneSeen", m.StreamDoneSeen).
		Set("applicationError", m.ApplicationError).Set("captureLimited", m.CaptureLimited).Set("malformed", m.Malformed)
	o.Set("timingSource", "coordinator-response-observer")
	if reKind.MatchString(m.ErrorKind) {
		o.Set("errorKind", m.ErrorKind)
	}
	var u any
	if m.Usage != nil && inStrs(m.Usage.Format, "gemini", "openai") {
		x := *m.Usage
		x.ReasoningIncluded = x.Format == "openai"
		x.ValidCache = x.Cached == nil || x.Input == nil || *x.Cached <= *x.Input
		if !inStrs(x.Source, "upstream-reported", "local-estimate", "response-reported-unverified") {
			x.Source = "response-reported-unverified"
		}
		u = x.JSON()
	}
	o.Set("usage", u)
	o.Set("usageComplete", m.UsageComplete && (m.TransportComplete || m.StreamDoneSeen) && u != nil && !m.ApplicationError && !m.CaptureLimited && !m.Malformed)
	return o
}

func (h *History) Finish(id, outcome string, status int, m *MetricsOut) error {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	h.mu.Lock()
	err := h.usable()
	old := h.rows[id]
	h.mu.Unlock()
	if err != nil {
		return err
	}
	if old == nil {
		return errors.New("History request missing")
	}
	if old.Phase == "finished" {
		return nil
	}
	if !inStrs(outcome, "success", "http_error", "application_error", "cancelled", "uncertain", "rejected") {
		return errors.New("Invalid outcome")
	}
	o, err := ParseObj(old.raw)
	if err != nil {
		return err
	}
	mj := metricsJSON(m)
	var cost *Cost
	if mj != nil && mj.V("usageComplete") == true {
		var p *Price
		if po := o.Obj("price"); po != nil {
			p, _ = priceFromObj(po)
		}
		u := m.Usage
		x := *u
		x.ReasoningIncluded = x.Format == "openai"
		cost = estimateCost(&x, p)
	} else {
		cost = unknownCost("usage_incomplete")
	}
	var hs any
	if status >= 100 && status <= 599 {
		hs = status
	}
	o.Set("phase", "finished").Set("outcome", outcome).Set("finishedAt", nowMs()).Set("httpStatus", hs)
	if mj == nil {
		o.Set("metrics", nil)
	} else {
		o.Set("metrics", mj)
	}
	o.Set("cost", cost.JSON())
	return h.persist(o)
}

func (h *History) ExpireStale(maxAge int64) int {
	h.wmu.Lock()
	defer h.wmu.Unlock()
	h.mu.Lock()
	if h.usable() != nil {
		h.mu.Unlock()
		return 0
	}
	now := nowMs()
	var stale []*HistRow
	for _, r := range h.rows {
		if r.Phase == "pending" && now-r.CreatedAt >= maxAge {
			stale = append(stale, r)
		}
	}
	h.mu.Unlock()
	n := 0
	for _, r := range stale {
		o, err := ParseObj(r.raw)
		if err != nil {
			continue
		}
		mj := metricsJSON(&MetricsOut{ErrorKind: "stale_pending"})
		o.Set("phase", "finished").Set("outcome", "uncertain").Set("finishedAt", now).Set("httpStatus", nil).Set("metrics", mj).Set("cost", unknownCost("usage_incomplete").JSON())
		if h.persist(o) != nil {
			break
		}
		n++
	}
	return n
}

type HistQuery struct {
	From, To            int64
	Model               string
	Account             *int64
	Outcome             string
	Page, PageSize      int64
}

func ParseHistQuery(q url.Values, summary bool) (*HistQuery, error) {
	out := &HistQuery{From: 0, To: 9007199254740991, Page: 1, PageSize: 20}
	allowed := map[string]bool{"from": true, "to": true, "model": true, "account": true, "outcome": true}
	if !summary {
		allowed["page"], allowed["pageSize"] = true, true
	}
	reNum := regexp.MustCompile(`^\d{1,16}$`)
	hasTo := false
	for k, vs := range q {
		if !allowed[k] || len(vs) != 1 {
			return nil, errors.New("Invalid analytics query")
		}
		v := vs[0]
		switch k {
		case "from", "to", "account", "page", "pageSize":
			if !reNum.MatchString(v) {
				return nil, errors.New("Invalid numeric filter")
			}
			n, _ := strconv.ParseInt(v, 10, 64)
			if n > 9007199254740991 {
				return nil, errors.New("Invalid numeric filter")
			}
			switch k {
			case "from":
				out.From = n
			case "to":
				out.To, hasTo = n, true
			case "account":
				out.Account = &n
			case "page":
				out.Page = n
			case "pageSize":
				out.PageSize = n
			}
		case "model":
			if !reHistModel.MatchString(v) {
				return nil, errors.New("Invalid model filter")
			}
			out.Model = v
		default:
			if !inStrs(v, "success", "http_error", "application_error", "cancelled", "uncertain", "rejected", "pending") {
				return nil, errors.New("Invalid outcome filter")
			}
			out.Outcome = v
		}
	}
	_ = hasTo
	if out.Page < 1 {
		return nil, errors.New("Invalid page")
	}
	if out.PageSize < 1 || out.PageSize > 100 {
		return nil, errors.New("Invalid page size")
	}
	if out.To < out.From {
		return nil, errors.New("Invalid time range")
	}
	return out, nil
}

func (h *History) selectRows(q *HistQuery) []*HistRow {
	var out []*HistRow
	for _, r := range h.rows {
		if r.CreatedAt >= q.From && r.CreatedAt < q.To && (q.Model == "" || r.Model == q.Model) &&
			(q.Account == nil || (r.Account != nil && *r.Account == *q.Account)) && (q.Outcome == "" || r.Outcome == q.Outcome) {
			out = append(out, r)
		}
	}
	return out
}

func (h *History) List(q *HistQuery) (*Obj, error) {
	if err := h.readable(); err != nil {
		return nil, err
	}
	h.mu.Lock()
	rows := h.selectRows(q)
	h.mu.Unlock()
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].CreatedAt != rows[j].CreatedAt {
			return rows[i].CreatedAt > rows[j].CreatedAt
		}
		return rows[i].ID > rows[j].ID
	})
	items := []any{}
	start := (q.Page - 1) * q.PageSize
	for i := start; i < start+q.PageSize && i < int64(len(rows)); i++ {
		if o, err := ParseObj(rows[i].raw); err == nil {
			items = append(items, o)
		}
	}
	return NewObj().Set("items", items).Set("total", len(rows)).Set("page", q.Page).Set("pageSize", q.PageSize).Set("health", h.Status()), nil
}
func (h *History) readable() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.ready {
		return herr(503, "Request history unavailable")
	}
	return nil
}

func (h *History) Summary(q *HistQuery) (*Obj, error) {
	if err := h.readable(); err != nil {
		return nil, err
	}
	h.mu.Lock()
	rows := h.selectRows(q)
	h.mu.Unlock()
	now := nowMs()
	var success, errs, cancelled, uncertain, pending, known, tKnown, tUnknown, priced, unpriced, rpm, tpmK, tpmU int64
	cost := 0.0
	dur, timed := 0.0, 0
	type grp struct {
		model                  string
		req, tok, unknown      int64
		first                  int
	}
	groups := map[string]*grp{}
	order := 0
	for _, r := range rows {
		switch r.Outcome {
		case "success":
			success++
		case "http_error", "application_error", "rejected":
			errs++
		case "cancelled":
			cancelled++
		case "uncertain":
			uncertain++
		case "pending":
			pending++
		}
		if r.Known {
			known += r.Total
			tKnown++
		} else {
			tUnknown++
		}
		if r.CostKnown {
			cost += r.Cost
			priced++
		} else {
			unpriced++
		}
		if r.Phase == "finished" && r.DurOK {
			dur += r.Dur
			timed++
		}
		if r.CreatedAt >= now-60000 && r.CreatedAt <= now {
			rpm++
		}
		if r.FinishedAt != nil && *r.FinishedAt >= now-60000 && *r.FinishedAt <= now {
			if r.Known {
				tpmK += r.Total
			} else {
				tpmU++
			}
		}
		g := groups[r.Model]
		if g == nil {
			g = &grp{model: r.Model, first: order}
			order++
			groups[r.Model] = g
		}
		g.req++
		if r.Known {
			g.tok += r.Total
		} else {
			g.unknown++
		}
	}
	gl := make([]*grp, 0, len(groups))
	for _, g := range groups {
		gl = append(gl, g)
	}
	sort.SliceStable(gl, func(i, j int) bool {
		if gl[i].req != gl[j].req {
			return gl[i].req > gl[j].req
		}
		return gl[i].first < gl[j].first
	})
	models := []any{}
	for _, g := range gl {
		models = append(models, NewObj().Set("model", g.model).Set("requests", g.req).Set("knownTokenTotal", g.tok).Set("tokenUnknownRequests", g.unknown))
	}
	var avg, rate any
	if timed > 0 {
		avg = dur / float64(timed)
	}
	if success+errs > 0 {
		rate = float64(errs) / float64(success+errs)
	}
	return NewObj().Set("requests", len(rows)).Set("success", success).Set("errors", errs).Set("cancelled", cancelled).Set("uncertain", uncertain).Set("pending", pending).
		Set("knownTokenTotal", known).Set("tokenKnownRequests", tKnown).Set("tokenUnknownRequests", tUnknown).
		Set("estimatedCostKnownSubtotal", cost).Set("pricedRequests", priced).Set("unpricedRequests", unpriced).Set("currency", "USD").
		Set("rpm", rpm).Set("tpmKnown", tpmK).Set("tpmUnknownRequests", tpmU).Set("averageDurationMs", avg).Set("errorRate", rate).
		Set("models", models).Set("health", h.Status()).Set("scope", "recorded-requests-only"), nil
}

func (h *History) Counts(tierOf func(int) string) (*Obj, error) {
	if err := h.readable(); err != nil {
		return nil, err
	}
	now := nowMs()
	const OFF = 8 * 3600000
	today := (now+OFF)/DAY*DAY - OFF
	ranges := []struct {
		name string
		from int64
	}{{"today", today}, {"week", today - 6*DAY}, {"month", today - 29*DAY}}
	type c4 struct{ req, ok, rl, er int64 }
	type grp struct {
		acct          *int64
		model         string
		c             [3]c4
		last, last429 int64
		first         int64
		seq           int
	}
	groups := map[string]*grp{}
	var list []*grp
	h.mu.Lock()
	for _, r := range h.rows {
		if r.CreatedAt < ranges[2].from || r.CreatedAt > now {
			continue
		}
		ak := "-"
		if r.Account != nil {
			ak = i64(*r.Account)
		}
		key := ak + "|" + r.Model
		g := groups[key]
		if g == nil {
			g = &grp{acct: r.Account, model: r.Model, first: r.CreatedAt}
			groups[key] = g
			list = append(list, g)
		}
		for i, rg := range ranges {
			if r.CreatedAt < rg.from {
				continue
			}
			c := &g.c[i]
			c.req++
			if r.Outcome == "success" {
				c.ok++
			} else if r.HTTPStatus != nil && *r.HTTPStatus == 429 {
				c.rl++
			} else if inStrs(r.Outcome, "http_error", "application_error", "rejected") {
				c.er++
			}
		}
		if r.CreatedAt > g.last {
			g.last = r.CreatedAt
		}
		if r.HTTPStatus != nil && *r.HTTPStatus == 429 && r.CreatedAt > g.last429 {
			g.last429 = r.CreatedAt
		}
	}
	h.mu.Unlock()
	sort.SliceStable(list, func(i, j int) bool { return list[i].c[2].req > list[j].c[2].req })
	items := []any{}
	for _, g := range list {
		o := NewObj()
		if g.acct == nil {
			o.Set("account", nil)
		} else {
			o.Set("account", *g.acct)
		}
		o.Set("model", g.model)
		for i, rg := range ranges {
			c := g.c[i]
			o.Set(rg.name, NewObj().Set("requests", c.req).Set("success", c.ok).Set("rateLimited", c.rl).Set("errors", c.er))
		}
		o.Set("lastAt", g.last).Set("last429At", g.last429)
		if g.acct != nil {
			o.Set("tier", tierOf(int(*g.acct)))
		} else {
			o.Set("tier", nil)
		}
		items = append(items, o)
	}
	rj := NewObj()
	for _, rg := range ranges {
		rj.Set(rg.name, rg.from)
	}
	return NewObj().Set("timezone", "Asia/Shanghai").Set("ranges", rj).Set("items", items).Set("health", h.Status()), nil
}

// ---- recorded forward health (recorded-forward.js) ----
type RecordHealth struct {
	mu                                        sync.Mutex
	BeginFailures, FinishFailures             int64
	LastFailureAt                             any
	UsageMissing, UsageMissingTotal           int64
	LastUsageMissing                          any
	missLog                                   string
}

func NewRecordHealth(missLog string) *RecordHealth {
	h := &RecordHealth{missLog: missLog, LastFailureAt: nil, LastUsageMissing: nil}
	if b, err := os.ReadFile(missLog); err == nil {
		lines := strings.Split(string(b), "\n")
		var nz []string
		for _, l := range lines {
			if l != "" {
				nz = append(nz, l)
			}
		}
		h.UsageMissingTotal = int64(len(nz))
		if len(nz) > 0 {
			if v, err := ParseJSON([]byte(nz[len(nz)-1])); err == nil {
				h.LastUsageMissing = v
			}
		}
	}
	return h
}
func (h *RecordHealth) persistMiss(row *Obj) {
	if h.missLog == "" {
		return
	}
	if st, err := os.Stat(h.missLog); err == nil && st.Size() > 1048576 {
		os.Rename(h.missLog, h.missLog+".1")
	}
	f, err := os.OpenFile(h.missLog, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err == nil {
		f.Write(append(MarshalJS(row), '\n'))
		f.Close()
	}
}
func (h *RecordHealth) JSON(hist *History) *Obj {
	h.mu.Lock()
	defer h.mu.Unlock()
	return NewObj().Set("beginFailures", h.BeginFailures).Set("finishFailures", h.FinishFailures).Set("lastFailureAt", h.LastFailureAt).
		Set("recordingPaused", false).Set("usageMissing", h.UsageMissing).Set("lastUsageMissing", h.LastUsageMissing).
		Set("usageMissingTotal", h.UsageMissingTotal).Set("history", hist.Status())
}

// outcome classification (recorded-forward.js)
func outcomeOf(r *Result) string {
	if r != nil && r.Cancelled {
		return "cancelled"
	}
	if r == nil || r.Uncertain {
		return "uncertain"
	}
	if r.Status >= 400 {
		return "http_error"
	}
	m := r.Metrics
	if m != nil && m.ApplicationError {
		return "application_error"
	}
	if r.Status >= 200 && r.Status < 300 && m != nil && (m.TransportComplete || m.StreamDoneSeen) {
		return "success"
	}
	return "uncertain"
}

// ---- model-prices.json ----
type sched struct {
	At    int64
	Price *Price
}
type PriceStore struct {
	mu        sync.Mutex
	file      string
	revision  int64
	prices    map[string]*Price
	porder    []string
	scheduled map[string][]sched
	sorder    []string
	blocked   bool
}

func (p *Price) fileJSON() *Obj {
	o := NewObj().Set("currency", p.Currency).Set("revision", p.Revision).Set("reasoningMode", p.ReasoningMode)
	fnull(o, "inputPerMillion", p.Input)
	fnull(o, "outputPerMillion", p.Output)
	fnull(o, "cachedPerMillion", p.Cached)
	fnull(o, "reasoningPerMillion", p.Reasoning)
	return o
}

var reDigits = regexp.MustCompile(`^\d+$`)

func cleanPrice(o *Obj, revision string) (*Price, error) {
	if o == nil {
		return nil, herr(400, "Invalid model price")
	}
	x := NewObj().Set("currency", o.V("currency")).Set("revision", revision).Set("reasoningMode", o.V("reasoningMode"))
	for _, k := range []string{"inputPerMillion", "outputPerMillion", "cachedPerMillion", "reasoningPerMillion"} {
		v := o.V(k)
		if f, ok := asNum(v); ok && f > 1000000 {
			return nil, herr(400, "Price rate too large")
		}
		x.Set(k, v)
	}
	p, err := priceFromObj(x)
	if err != nil {
		return nil, herr(400, "Invalid model price")
	}
	return p, nil
}

func NewPriceStore(file string) (*PriceStore, error) {
	s := &PriceStore{file: file, prices: map[string]*Price{}, scheduled: map[string][]sched{}}
	st, err := os.Lstat(file)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, errors.New("Price configuration invalid; file preserved")
	}
	bad := errors.New("Price configuration invalid; file preserved")
	if !st.Mode().IsRegular() || st.Size() > 2097152 {
		return nil, bad
	}
	raw, err := readJSONFile(file)
	d := asObj(raw)
	if err != nil || d == nil {
		return nil, bad
	}
	v, _ := asSafeInt(d.V("version"))
	rev, okr := asSafeInt(d.V("revision"))
	if v != 1 || !okr || rev < 0 || d.Obj("prices") == nil {
		return nil, bad
	}
	for _, m := range d.Obj("prices").Keys() {
		po := d.Obj("prices").Obj(m)
		pr := po.Str("revision")
		n, _ := strconv.ParseInt(pr, 10, 64)
		if !reCanonModel.MatchString(m) || !reDigits.MatchString(pr) || n > rev {
			return nil, bad
		}
		p, err := cleanPrice(po, pr)
		if err != nil {
			return nil, bad
		}
		s.prices[m] = p
		s.porder = append(s.porder, m)
	}
	if sc := d.Obj("scheduled"); d.Has("scheduled") {
		if sc == nil {
			return nil, bad
		}
		for _, m := range sc.Keys() {
			list := sc.Arr(m)
			if !reCanonModel.MatchString(m) || list == nil || len(list) > 20 {
				return nil, bad
			}
			var out []sched
			for _, e := range list {
				eo := asObj(e)
				at, ok := asSafeInt(eo.V("effectiveAt"))
				pr := eo.Obj("price").Str("revision")
				n, _ := strconv.ParseInt(pr, 10, 64)
				if !ok || at < 0 || !reDigits.MatchString(pr) || n > rev {
					return nil, bad
				}
				p, err := cleanPrice(eo.Obj("price"), pr)
				if err != nil {
					return nil, bad
				}
				out = append(out, sched{at, p})
			}
			sort.SliceStable(out, func(i, j int) bool { return out[i].At < out[j].At })
			s.scheduled[m] = out
			s.sorder = append(s.sorder, m)
		}
	}
	s.revision = rev
	return s, nil
}

func (s *PriceStore) effective(m string, at int64) *Price {
	p := s.prices[m]
	for _, e := range s.scheduled[m] {
		if e.At <= at {
			p = e.Price
		}
	}
	return p
}
func (s *PriceStore) Get(m string) *Price {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.blocked {
		return nil
	}
	return s.effective(m, nowMs()).clone()
}
func schedJSON(list []sched) []any {
	out := []any{}
	for _, e := range list {
		out = append(out, NewObj().Set("effectiveAt", e.At).Set("price", e.Price.fileJSON()))
	}
	return out
}
func (s *PriceStore) Snapshot() *Obj {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := nowMs()
	prices, scheduled := NewObj(), NewObj()
	seen := map[string]bool{}
	for _, m := range append(append([]string(nil), s.porder...), s.sorder...) {
		if seen[m] {
			continue
		}
		seen[m] = true
		if p := s.effective(m, now); p != nil {
			prices.Set(m, p.fileJSON())
		}
		var fut []sched
		for _, e := range s.scheduled[m] {
			if e.At > now {
				fut = append(fut, e)
			}
		}
		if len(fut) > 0 {
			scheduled.Set(m, schedJSON(fut))
		}
	}
	return NewObj().Set("version", 1).Set("revision", s.revision).Set("prices", prices).Set("scheduled", scheduled).
		Set("blocked", s.blocked).Set("currency", "USD").Set("estimated", true)
}

func (s *PriceStore) Set(in *Obj) (*Obj, error) {
	s.mu.Lock()
	if s.blocked {
		s.mu.Unlock()
		return nil, herr(503, "Price storage blocked; reconcile before retry")
	}
	model := in.Str("model")
	if !reCanonModel.MatchString(model) {
		s.mu.Unlock()
		return nil, herr(400, "Canonical model ID required")
	}
	rv, ok := asSafeInt(in.V("revision"))
	if !ok || rv < 0 {
		s.mu.Unlock()
		return nil, herr(400, "Invalid price revision")
	}
	if rv != s.revision {
		s.mu.Unlock()
		return nil, herr(409, "Price revision changed; refresh first")
	}
	revision := s.revision + 1
	rs := i64(revision)
	now := nowMs()
	prices := map[string]*Price{}
	for k, v := range s.prices {
		prices[k] = v
	}
	porder := append([]string(nil), s.porder...)
	scheduled := map[string][]sched{}
	for k, v := range s.scheduled {
		scheduled[k] = v
	}
	sorder := append([]string(nil), s.sorder...)
	setP := func(m string, p *Price) {
		if _, ok := prices[m]; !ok {
			porder = append(porder, m)
		}
		prices[m] = p
	}
	delS := func(m string) {
		delete(scheduled, m)
		for i, x := range sorder {
			if x == m {
				sorder = append(sorder[:i:i], sorder[i+1:]...)
				break
			}
		}
	}
	setS := func(m string, l []sched) {
		if _, ok := scheduled[m]; !ok {
			sorder = append(sorder, m)
		}
		scheduled[m] = l
	}
	future := func(m string) []sched {
		var out []sched
		for _, e := range s.scheduled[m] {
			if e.At > now {
				out = append(out, e)
			}
		}
		return out
	}
	fail := func(e error) (*Obj, error) { s.mu.Unlock(); return nil, e }
	if in.V("clearScheduled") == true {
		if b := s.effective(model, now); b != nil {
			setP(model, b)
		}
		delS(model)
	} else if ev := in.V("effectiveAt"); ev != nil {
		at, ok := asSafeInt(ev)
		if !ok || at <= now || at > now+5*366*DAY {
			return fail(herr(400, "Effective time must be in the future"))
		}
		p, err := cleanPrice(in.Obj("price"), rs)
		if err != nil {
			return fail(err)
		}
		var list []sched
		for _, e := range future(model) {
			if e.At != at {
				list = append(list, e)
			}
		}
		if len(list) >= 20 {
			return fail(herr(400, "Too many scheduled prices"))
		}
		if b := s.effective(model, now); b != nil {
			setP(model, b)
		}
		list = append(list, sched{at, p})
		sort.SliceStable(list, func(i, j int) bool { return list[i].At < list[j].At })
		setS(model, list)
	} else {
		p, err := cleanPrice(in.Obj("price"), rs)
		if err != nil {
			return fail(err)
		}
		if _, ok := s.prices[model]; !ok && len(s.prices) >= 1000 {
			return fail(herr(400, "Price catalog capacity reached"))
		}
		setP(model, p)
		if f := future(model); len(f) > 0 {
			setS(model, f)
		} else {
			delS(model)
		}
	}
	po := NewObj()
	for _, m := range porder {
		po.Set(m, prices[m].fileJSON())
	}
	file := NewObj().Set("version", 1).Set("revision", revision).Set("prices", po)
	if len(sorder) > 0 {
		so := NewObj()
		for _, m := range sorder {
			so.Set(m, schedJSON(scheduled[m]))
		}
		file.Set("scheduled", so)
	}
	if err := writeAtomic(s.file, append(MarshalJS(file), '\n'), 0600, true); err != nil {
		s.blocked = true
		return fail(herr(503, "Price save not confirmed; reconcile before retry"))
	}
	s.prices, s.porder, s.scheduled, s.sorder, s.revision = prices, porder, scheduled, sorder, revision
	s.mu.Unlock()
	return s.Snapshot(), nil
}