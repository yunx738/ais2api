package main

// Passive response observer (response-metrics.js) + usage normalisation / cost estimate (usage-metrics.js).
import (
	"bytes"
	"errors"
	"regexp"
	"strings"
	"sync"
)

type Usage struct {
	Input, Output, Cached, Reasoning, Total *int64
	Format, Source                          string
	ReasoningIncluded, ValidCache           bool
}

func (u *Usage) JSON() *Obj {
	if u == nil {
		return nil
	}
	o := NewObj()
	for _, kv := range []struct {
		k string
		v *int64
	}{{"input", u.Input}, {"output", u.Output}, {"cached", u.Cached}, {"reasoning", u.Reasoning}, {"total", u.Total}} {
		if kv.v == nil {
			o.Set(kv.k, nil)
		} else {
			o.Set(kv.k, *kv.v)
		}
	}
	return o.Set("format", u.Format).Set("source", u.Source).Set("reasoningIncludedInOutput", u.ReasoningIncluded).Set("validCache", u.ValidCache)
}

func cnt(v any) *int64 {
	if n, ok := asCount(v); ok {
		return &n
	}
	return nil
}
func i64p(n int64) *int64 { return &n }

func normalizeUsage(o *Obj) *Usage {
	if o == nil {
		return nil
	}
	native := o.Obj("usageMetadata")
	openai := o.Obj("usage")
	u := native
	if u == nil {
		u = openai
	}
	if u == nil {
		return nil
	}
	var in, out, cached, reasoning, total *int64
	if native != nil {
		in, out, cached, reasoning, total = cnt(u.V("promptTokenCount")), cnt(u.V("candidatesTokenCount")), cnt(u.V("cachedContentTokenCount")), cnt(u.V("thoughtsTokenCount")), cnt(u.V("totalTokenCount"))
	} else {
		in, out, total = cnt(u.V("prompt_tokens")), cnt(u.V("completion_tokens")), cnt(u.V("total_tokens"))
		cached = cnt(u.Obj("prompt_tokens_details").V("cached_tokens"))
		reasoning = cnt(u.Obj("completion_tokens_details").V("reasoning_tokens"))
	}
	if in == nil && out == nil && cached == nil && reasoning == nil && total == nil {
		return nil
	}
	if native != nil && reasoning == nil && in != nil {
		reasoning = i64p(0)
	}
	if out == nil && in != nil && total != nil {
		d := *total - *in
		if native != nil {
			d -= *reasoning
		}
		if d >= 0 {
			out = &d
		}
	}
	f := "openai"
	if native != nil {
		f = "gemini"
	}
	return &Usage{Input: in, Output: out, Cached: cached, Reasoning: reasoning, Total: total, Format: f,
		Source: "response-reported-unverified", ReasoningIncluded: native == nil,
		ValidCache: cached == nil || in == nil || *cached <= *in}
}

type MetricsOut struct {
	Usage                                                  *Usage
	UsageComplete                                          bool
	FirstByteMs, FirstContentMs, DurationMs                *int64
	TransportComplete, StreamDoneSeen, ApplicationError    bool
	CaptureLimited, Malformed                              bool
	ErrorKind                                              string
}

type Metrics struct {
	mu                       sync.Mutex
	stream                   bool
	max                      int
	started                  int64
	firstByte, firstContent  *int64
	buf                      []byte
	event                    [][]byte
	eventBytes               int
	discardEvent, discardLine bool
	usage                    *Usage
	complete, limited        bool
	malformed, done, appErr  bool
	closed                   bool
	errorKind                string
	duration                 int64
	out                      *MetricsOut
}

func NewMetrics(stream bool) *Metrics {
	return &Metrics{stream: stream, max: 1048576, started: nowMs()}
}

var reKind = regexp.MustCompile(`^[A-Za-z0-9_]{1,40}$`)

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	}
	if f, ok := asNum(v); ok {
		return f != 0
	}
	return true
}
func jsString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case nil:
		return "null"
	}
	if f, ok := asNum(v); ok {
		return jsNum(f)
	}
	return string(MarshalJS(v))
}

func (m *Metrics) accept(v any) {
	if a, ok := v.([]any); ok {
		for _, x := range a {
			m.accept(x)
		}
		return
	}
	o := asObj(v)
	if o == nil {
		return
	}
	if u := normalizeUsage(o); u != nil {
		m.usage = u
	}
	if truthy(o.V("error")) {
		m.appErr = true
		if e := o.Obj("error"); e != nil && m.errorKind == "" {
			var st any
			for _, k := range []string{"status", "type", "code"} {
				if truthy(e.V(k)) {
					st = e.V(k)
					break
				}
			}
			if st != nil && reKind.MatchString(jsString(st)) {
				m.errorKind = jsString(st)
			}
		}
	}
	text := false
	for _, c := range o.Arr("choices") {
		co := asObj(c)
		if s, ok := co.Obj("delta").V("content").(string); ok && s != "" {
			text = true
		}
		if s, ok := co.Obj("message").V("content").(string); ok && s != "" {
			text = true
		}
	}
	for _, c := range o.Arr("candidates") {
		for _, p := range asObj(c).Obj("content").Arr("parts") {
			po := asObj(p)
			if s, ok := po.V("text").(string); ok && s != "" && po.V("thought") != true {
				text = true
			}
		}
	}
	if text && m.firstContent == nil {
		m.firstContent = i64p(nowMs() - m.started)
	}
}
func (m *Metrics) parse(b []byte) {
	t := bytes.TrimSpace(b)
	if len(t) == 0 {
		return
	}
	if string(t) == "[DONE]" {
		m.done = true
		return
	}
	v, err := ParseJSON(b)
	if err != nil {
		m.malformed = true
		return
	}
	m.accept(v)
}
func (m *Metrics) line(l []byte) {
	l = bytes.TrimSuffix(l, []byte("\r"))
	if len(l) == 0 {
		if !m.discardEvent && len(m.event) > 0 {
			m.parse(bytes.Join(m.event, []byte("\n")))
		}
		m.event, m.eventBytes, m.discardEvent = nil, 0, false
		return
	}
	if m.discardEvent || !bytes.HasPrefix(l, []byte("data:")) {
		return
	}
	d := l[5:]
	if len(d) > 0 && d[0] == ' ' {
		d = d[1:]
	}
	m.eventBytes += len(d) + 1
	if m.eventBytes > m.max {
		m.limited, m.discardEvent, m.event = true, true, nil
		return
	}
	m.event = append(m.event, append([]byte(nil), d...))
}
func (m *Metrics) feed(b []byte) {
	if !m.stream {
		if m.limited {
			return
		}
		if len(m.buf)+len(b) > m.max {
			m.limited, m.buf = true, nil
			return
		}
		m.buf = append(m.buf, b...)
		return
	}
	for len(b) > 0 {
		nl := bytes.IndexByte(b, '\n')
		part := b
		if nl >= 0 {
			part = b[:nl]
		}
		if !m.discardLine {
			if len(m.buf)+len(part) > m.max {
				m.buf, m.discardLine, m.discardEvent, m.event, m.limited = nil, true, true, nil, true
			} else {
				m.buf = append(m.buf, part...)
			}
		}
		if nl < 0 {
			break
		}
		if !m.discardLine {
			m.line(m.buf)
		}
		m.buf, m.discardLine = m.buf[:0], false
		b = b[nl+1:]
	}
}
func (m *Metrics) Write(b []byte) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	if len(b) > 0 && m.firstByte == nil {
		m.firstByte = i64p(nowMs() - m.started)
	}
	m.feed(b)
}

var reSSEStart = regexp.MustCompile(`^\s*(data:|:)`)

func (m *Metrics) Finish(complete bool) *MetricsOut {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.closed {
		if m.stream {
			if len(m.buf) > 0 && !m.discardLine {
				m.line(m.buf)
			}
			if complete {
				m.line(nil)
			}
		} else if complete && !m.limited {
			if reSSEStart.Match(m.buf) {
				t := m.buf
				m.buf, m.stream = nil, true
				m.feed(t)
				if len(m.buf) > 0 {
					m.line(m.buf)
				}
				m.line(nil)
			} else {
				m.parse(m.buf)
			}
		}
		m.closed, m.complete, m.duration = true, complete, nowMs()-m.started
		m.buf, m.event = nil, nil
	}
	if m.out == nil {
		m.out = &MetricsOut{Usage: m.usage, UsageComplete: m.usage != nil && (m.complete || m.done) && !m.limited && !m.malformed && !m.appErr,
			FirstByteMs: m.firstByte, FirstContentMs: m.firstContent, DurationMs: i64p(m.duration), TransportComplete: m.complete,
			StreamDoneSeen: m.done, ApplicationError: m.appErr, CaptureLimited: m.limited, Malformed: m.malformed, ErrorKind: m.errorKind}
	}
	return m.out
}

// ---- prices / cost ----
type Price struct {
	Currency, Revision                string
	Input, Output, Cached, Reasoning *float64
	ReasoningMode                     string
}

func fp(v any) (*float64, bool) {
	if v == nil {
		return nil, true
	}
	f, ok := asNum(v)
	if !ok {
		return nil, false
	}
	return &f, true
}
func priceFromObj(o *Obj) (*Price, error) {
	if o == nil {
		return nil, errors.New("Invalid price metadata")
	}
	p := &Price{Currency: o.Str("currency"), ReasoningMode: o.Str("reasoningMode")}
	rv, ok := o.V("revision").(string)
	if !ok {
		return nil, errors.New("Invalid price metadata")
	}
	p.Revision = rv
	var ok1, ok2, ok3, ok4 bool
	p.Input, ok1 = fp(o.V("inputPerMillion"))
	p.Output, ok2 = fp(o.V("outputPerMillion"))
	p.Cached, ok3 = fp(o.V("cachedPerMillion"))
	p.Reasoning, ok4 = fp(o.V("reasoningPerMillion"))
	if !ok1 || !ok2 || !ok3 || !ok4 || !o.Has("inputPerMillion") || !o.Has("outputPerMillion") || !o.Has("cachedPerMillion") || !o.Has("reasoningPerMillion") {
		return nil, errors.New("Invalid price rate")
	}
	return p, p.validate()
}
func (p *Price) validate() error {
	if p == nil || p.Currency != "USD" || p.Revision == "" || !inStrs(p.ReasoningMode, "included", "separate", "unknown") {
		return errors.New("Invalid price metadata")
	}
	for _, x := range []*float64{p.Input, p.Output, p.Cached, p.Reasoning} {
		if x != nil && *x < 0 {
			return errors.New("Invalid price rate")
		}
	}
	return nil
}
func fnull(o *Obj, k string, f *float64) {
	if f == nil {
		o.Set(k, nil)
	} else {
		o.Set(k, *f)
	}
}
func (p *Price) JSON() *Obj {
	if p == nil {
		return nil
	}
	o := NewObj().Set("currency", p.Currency).Set("revision", p.Revision)
	fnull(o, "inputPerMillion", p.Input)
	fnull(o, "outputPerMillion", p.Output)
	fnull(o, "cachedPerMillion", p.Cached)
	fnull(o, "reasoningPerMillion", p.Reasoning)
	return o.Set("reasoningMode", p.ReasoningMode)
}
func (p *Price) clone() *Price {
	if p == nil {
		return nil
	}
	c := *p
	return &c
}

type Cost struct {
	Amount        *float64
	Currency      string
	Reason        any // string or nil
	PriceRevision string
	UsageSource   string
	raw           *Obj // cost loaded from an older file, kept verbatim
}

func (c *Cost) JSON() *Obj {
	if c == nil {
		return nil
	}
	if c.raw != nil {
		return c.raw
	}
	o := NewObj()
	fnull(o, "amount", c.Amount)
	o.Set("currency", c.Currency).Set("estimated", true).Set("reason", c.Reason)
	if c.PriceRevision != "" {
		o.Set("priceRevision", c.PriceRevision).Set("usageSource", c.UsageSource)
	}
	return o
}
func unknownCost(reason string) *Cost { return &Cost{Currency: "USD", Reason: reason} }

func estimateCost(u *Usage, p *Price) *Cost {
	if u == nil {
		return unknownCost("usage_missing")
	}
	if p == nil {
		return unknownCost("price_missing")
	}
	if p.validate() != nil {
		return unknownCost("price_invalid")
	}
	if u.Input == nil || u.Output == nil {
		return unknownCost("token_breakdown_missing")
	}
	if p.Input == nil || p.Output == nil {
		return unknownCost("rate_missing")
	}
	v := float64(*u.Input) * *p.Input
	v += float64(*u.Output) * *p.Output
	if !u.ReasoningIncluded {
		if p.ReasoningMode == "unknown" {
			return unknownCost("reasoning_price_unknown")
		}
		if p.ReasoningMode == "separate" {
			if u.Reasoning == nil {
				return unknownCost("reasoning_count_missing")
			}
			if *u.Reasoning > 0 && p.Reasoning == nil {
				return unknownCost("reasoning_rate_missing")
			}
			r := 0.0
			if p.Reasoning != nil {
				r = *p.Reasoning
			}
			v += float64(*u.Reasoning) * r
		}
	}
	a := v / 1e6
	return &Cost{Amount: &a, Currency: p.Currency, Reason: nil, PriceRevision: p.Revision, UsageSource: u.Source}
}

func lower(s string) string { return strings.ToLower(s) }