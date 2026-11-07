package main

// forward(): recorded-forward.js + headless-forward.js + build wrapForward + settling().
// Three paths: Build (__build), anti-truncation/, passthrough. Fake streaming (stream-mode.json = fake)
// turns a client stream request into one buffered upstream call delivered as SSE frames, with keep-alive
// while waiting; errors on early-opened streams become stream error events.
import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"time"
)

var retryStatus = map[int]bool{401: true, 403: true, 429: true}

func rejectionOf(status int, h http.Header, body []byte) *Rejection {
	ct := h.Get("Content-Type")
	if ct == "" {
		ct = "application/json"
	}
	r := &Rejection{Status: status, Headers: map[string]string{"content-type": ct}, Body: body}
	if v := h.Get("Retry-After"); v != "" {
		r.Headers["retry-after"] = v
	}
	return r
}
func jsonRejection(status int, payload *Obj, retryAfter string, extra map[string]string) *Rejection {
	r := &Rejection{Status: status, Headers: map[string]string{"content-type": "application/json"}, Body: MarshalJS(payload)}
	if retryAfter != "" {
		r.Headers["retry-after"] = retryAfter
	}
	for k, v := range extra {
		r.Headers[k] = v
	}
	return r
}

// app.forward is called by the scheduler for every execution (outside app.mu).
func (a *App) forward(ctx context.Context, t *Ticket, it *Item) (result *Result) {
	a.mu.Lock()
	a.disp.live[t.ID] = &liveExec{ticket: t, res: it.res}
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.disp.live, t.ID)
		a.disp.settle(t)
		a.mu.Unlock()
	}()
	// history begin
	requested := it.model
	price := a.prices.Get(t.Model)
	started := false
	if a.hist != nil {
		if err := a.hist.Begin(BeginInput{ID: t.ID, Model: t.Model, RequestedModel: requested, Account: t.Account, WorkerEpoch: a.disp.epoch, Stream: it.stream, Price: price}); err == nil {
			started = true
		} else {
			a.health.mu.Lock()
			a.health.BeginFailures++
			a.health.LastFailureAt = nowMs()
			a.health.mu.Unlock()
		}
	}
	defer func() {
		if !started {
			return
		}
		out := outcomeOf(result)
		var m *MetricsOut
		st := 0
		if result != nil {
			m, st = result.Metrics, result.Status
		}
		if out == "success" && (m == nil || !m.UsageComplete) {
			row := NewObj().Set("at", nowMs()).Set("id", t.ID).Set("model", t.Model).Set("stream", m != nil).
				Set("malformed", m != nil && m.Malformed).Set("hasUsage", m != nil && m.Usage != nil).Set("doneSeen", m != nil && m.StreamDoneSeen)
			a.health.mu.Lock()
			a.health.UsageMissing++
			a.health.UsageMissingTotal++
			a.health.LastUsageMissing = row
			a.health.mu.Unlock()
			errf("[Usage] success without complete usage %s", MarshalJS(row))
			a.health.persistMiss(row)
		}
		if err := a.hist.Finish(t.ID, out, st, m); err != nil {
			a.health.mu.Lock()
			a.health.FinishFailures++
			a.health.LastFailureAt = nowMs()
			a.health.mu.Unlock()
		}
	}()
	if it.plan != nil && it.plan.Build != nil {
		return a.forwardBuild(ctx, t, it)
	}
	return a.forwardHeadless(ctx, t, it, it.body)
}

func (a *App) forwardHeadless(ctx context.Context, t *Ticket, it *Item, body []byte) *Result {
	if ctx.Err() != nil {
		return &Result{Uncertain: true}
	}
	email := a.acc.Email(t.Account)
	if email == "" {
		it.res.JSON(503, NewObj().Set("error", NewObj().Set("message", "账号 #"+itoa(t.Account)+" 没有登录邮箱，无浏览器服务无法使用").Set("code", "headless_account_unknown")), nil)
		return &Result{Status: 503, WorkerRejection: "headless_account"}
	}
	var r *Result
	func() {
		defer func() {
			if p := recover(); p != nil {
				errf("[HL] forward failed: %v", p)
				if !it.res.HeadersSent() || it.res.Soft() {
					it.res.JSON(502, NewObj().Set("error", NewObj().Set("message", "无浏览器执行失败").Set("code", "headless_failed")), nil)
					r = &Result{Status: 502}
				} else {
					it.res.Destroy()
					r = &Result{Uncertain: true}
				}
			}
		}()
		if it.plan != nil && it.plan.Build != nil {
			r = a.buildCall(ctx, t, it, email, body)
		} else if !it.native && strings.HasPrefix(it.parsed.Str("model"), AT_PREFIX) {
			r = a.antiTruncation(ctx, t, it, email)
		} else if it.soft != "" {
			r = a.fakeStream(ctx, t, it, email)
		} else {
			r = a.passthrough(ctx, t, it, email)
		}
	}()
	return r
}

// upstreamPath: the route sent to the service. Pins (@31 / @g:组) are removed from the model already.
func (it *Item) upstreamPath() string {
	if it.native {
		p := "/v1beta/models/" + it.plan.Model + ":"
		if it.stream {
			p += "streamGenerateContent"
		} else {
			p += "generateContent"
		}
		if it.query != "" {
			p += "?" + it.query
		}
		return p
	}
	return "/v1/chat/completions"
}

func (a *App) passthrough(ctx context.Context, t *Ticket, it *Item, email string) *Result {
	res := it.res
	up, err := a.svc.Request(ctx, email, "POST", it.upstreamPath(), it.body)
	if err != nil {
		if ctx.Err() != nil {
			return &Result{Uncertain: true}
		}
		res.JSON(502, NewObj().Set("error", NewObj().Set("message", "无浏览器服务连接失败").Set("code", "headless_unavailable")), nil)
		return &Result{Status: 502}
	}
	defer up.Body.Close()
	status := up.StatusCode
	ra := up.Header.Get("Retry-After")
	stream := strings.Contains(up.Header.Get("Content-Type"), "text/event-stream")
	obs := NewMetrics(stream)
	held := retryStatus[status]
	var chunks bytes.Buffer
	publish := func() {
		h := res.Header()
		for _, k := range []string{"Content-Type", "Retry-After", "Cache-Control"} {
			if v := up.Header.Get(k); v != "" {
				h.Set(k, v)
			}
		}
		res.SetStatus(status)
	}
	if !held {
		publish()
	}
	buf := make([]byte, 32*1024)
	for {
		n, rerr := up.Body.Read(buf)
		if n > 0 {
			c := buf[:n]
			obs.Write(c)
			if held {
				chunks.Write(c)
				if chunks.Len() > 65536 {
					held = false
					publish()
					if !res.Write(chunks.Bytes()) {
						return &Result{Status: status, RetryAfter: ra, Cancelled: true, Metrics: obs.Finish(false)}
					}
					chunks.Reset()
				}
			} else if !res.Write(c) {
				if stream && obs.done {
					return &Result{Status: status, RetryAfter: ra, Uncertain: true, Metrics: obs.Finish(false)}
				}
				return &Result{Status: status, RetryAfter: ra, Cancelled: true, Metrics: obs.Finish(false)}
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			res.Destroy()
			if ctx.Err() != nil && !res.Destroyed() {
				return &Result{Status: status, RetryAfter: ra, Uncertain: true, Metrics: obs.Finish(false)}
			}
			if res.Destroyed() && !(stream && obs.done) {
				return &Result{Status: status, RetryAfter: ra, Cancelled: true, Metrics: obs.Finish(false)}
			}
			return &Result{Status: status, RetryAfter: ra, Uncertain: true, Metrics: obs.Finish(false)}
		}
	}
	if held {
		return &Result{Status: status, RetryAfter: ra, Rejection: rejectionOf(status, up.Header, chunks.Bytes()), Metrics: obs.Finish(true)}
	}
	res.End(nil)
	return &Result{Status: status, RetryAfter: ra, Metrics: obs.Finish(true)}
}

// ---------------- completion writers ----------------
func writeCompletion(res *Resp, model string, stream bool, message *Obj, finish string, usage *Obj) {
	id := "chatcmpl-" + uuid4()
	created := time.Now().Unix()
	if stream {
		if !res.HeadersSent() {
			h := res.Header()
			h.Set("Content-Type", "text/event-stream; charset=utf-8")
			h.Set("Cache-Control", "no-cache")
			res.SetStatus(200)
		}
		res.Commit()
		base := func() *Obj { return NewObj().Set("id", id).Set("object", "chat.completion.chunk").Set("created", created).Set("model", model) }
		var frames []*Obj
		delta := func(k string, v any) {
			frames = append(frames, base().Set("choices", []any{NewObj().Set("index", 0).Set("delta", NewObj().Set("role", "assistant").Set(k, v)).Set("finish_reason", nil)}))
		}
		if truthy(message.V("reasoning_content")) {
			delta("reasoning_content", message.V("reasoning_content"))
		}
		if truthy(message.V("content")) {
			delta("content", message.V("content"))
		}
		if tc := message.Arr("tool_calls"); tc != nil {
			var calls []any
			for i, c := range tc {
				x := NewObj().Set("index", i)
				for _, k := range asObj(c).Keys() {
					x.Set(k, asObj(c).V(k))
				}
				calls = append(calls, x)
			}
			delta("tool_calls", calls)
		}
		last := base().Set("choices", []any{NewObj().Set("index", 0).Set("delta", NewObj()).Set("finish_reason", finish)})
		if usage != nil {
			last.Set("usage", usage)
		}
		frames = append(frames, last)
		var b bytes.Buffer
		for _, f := range frames {
			b.WriteString("data: ")
			b.Write(MarshalJS(f))
			b.WriteString("\n\n")
		}
		b.WriteString("data: [DONE]\n\n")
		res.End(b.Bytes())
		return
	}
	o := NewObj().Set("id", id).Set("object", "chat.completion").Set("created", created).Set("model", model).
		Set("choices", []any{NewObj().Set("index", 0).Set("message", message).Set("finish_reason", finish)})
	if usage != nil {
		o.Set("usage", usage)
	}
	res.JSON(200, o, nil)
}

// ---------------- anti-truncation ----------------
const AT_PREFIX = "anti-truncation/"

func (a *App) antiTruncation(ctx context.Context, t *Ticket, it *Item, email string) *Result {
	res := it.res
	model := it.parsed.Str("model")
	real := model[len(AT_PREFIX):]
	stream := it.parsed.V("stream") == true
	body := it.parsed.Clone()
	body.Set("model", real)
	obs := NewMetrics(stream)
	res.mu.Lock()
	res.tap = obs
	res.mu.Unlock()
	t0 := nowMs()
	call := func(b *Obj) *CallResult {
		r := a.svc.Call(ctx, email, "POST", "/v1/chat/completions", b)
		if r.Err != nil {
			st := 502
			if ctx.Err() != nil {
				st = 499
			}
			return &CallResult{Status: st, JSON: NewObj().Set("error", NewObj().Set("message", clipRunes(r.Err.Error(), 200)))}
		}
		return r
	}
	r := atRun(ctx, call, body, a.atPrompt.Preset())
	st := r.status
	if r.ok {
		st = 200
	}
	rounds := "-"
	if r.rounds > 0 {
		rounds = itoa(r.rounds)
	}
	logf("[HL] AT #%d %s ok=%v status=%d rounds=%s ms=%d", t.Account, real, r.ok, st, rounds, nowMs()-t0)
	if r.cancelled || res.Destroyed() {
		return &Result{Cancelled: true, Metrics: obs.Finish(false)}
	}
	if !r.ok {
		if r.upstream && retryStatus[st] {
			return &Result{Status: st, RetryAfter: r.retryAfter, Rejection: jsonRejection(st, r.payload, r.retryAfter, nil), Metrics: obs.Finish(true)}
		}
		var h map[string]string
		if r.retryAfter != "" {
			h = map[string]string{"Retry-After": r.retryAfter}
		}
		res.JSON(st, r.payload, h)
		return &Result{Status: st, RetryAfter: r.retryAfter, Metrics: obs.Finish(true)}
	}
	msg := NewObj().Set("role", "assistant").Set("content", r.answer)
	if r.reasoning != "" {
		msg.Set("reasoning_content", r.reasoning)
	}
	writeCompletion(res, model, stream, msg, "stop", r.usage)
	return &Result{Status: 200, Metrics: obs.Finish(true)}
}

// ---------------- fake streaming ----------------
// One buffered upstream call; the client already holds an open stream with keep-alive.
func (a *App) fakeStream(ctx context.Context, t *Ticket, it *Item, email string) *Result {
	res := it.res
	var body []byte
	path := it.upstreamPath()
	if it.native {
		path = "/v1beta/models/" + it.plan.Model + ":generateContent"
		body = it.body
	} else {
		b := it.parsed.Clone()
		b.Set("stream", false)
		b.Del("stream_options")
		body = MarshalJS(b)
	}
	obs := NewMetrics(false)
	up, err := a.svc.Request(ctx, email, "POST", path, body)
	if err != nil {
		if ctx.Err() != nil {
			return &Result{Uncertain: true}
		}
		res.JSON(502, NewObj().Set("error", NewObj().Set("message", "无浏览器服务连接失败").Set("code", "headless_unavailable")), nil)
		return &Result{Status: 502, Metrics: obs.Finish(true)}
	}
	defer up.Body.Close()
	data, rerr := io.ReadAll(io.LimitReader(up.Body, 64*1024*1024))
	if rerr != nil {
		if res.Destroyed() {
			return &Result{Cancelled: true, Metrics: obs.Finish(false)}
		}
		res.Destroy()
		return &Result{Uncertain: true, Metrics: obs.Finish(false)}
	}
	st := up.StatusCode
	ra := up.Header.Get("Retry-After")
	obs.Write(data)
	if st != 200 {
		if retryStatus[st] {
			return &Result{Status: st, RetryAfter: ra, Rejection: rejectionOf(st, up.Header, data), Metrics: obs.Finish(true)}
		}
		p, perr := ParseObj(data)
		if perr != nil || p.V("error") == nil {
			p = NewObj().Set("error", NewObj().Set("message", clipRunes(string(data), 500)).Set("code", st))
		}
		res.JSON(st, p, nil)
		return &Result{Status: st, Metrics: obs.Finish(true)}
	}
	j, perr := ParseObj(data)
	if perr != nil {
		res.JSON(502, NewObj().Set("error", NewObj().Set("message", "上游回复无法解析").Set("code", "bad_upstream_reply")), nil)
		return &Result{Status: 502, Metrics: obs.Finish(true)}
	}
	res.Commit()
	if it.native {
		if res.sseKind == "gemini-array" {
			res.End([]byte(string(MarshalJS(j)) + "]"))
		} else {
			res.End([]byte("data: " + string(MarshalJS(j)) + "\r\n\r\n"))
		}
		return &Result{Status: 200, Metrics: obs.Finish(true)}
	}
	var ch *Obj
	if c := j.Arr("choices"); len(c) > 0 {
		ch = asObj(c[0])
	}
	msg := ch.Obj("message")
	if msg == nil {
		msg = NewObj().Set("role", "assistant").Set("content", "")
	}
	fin := ch.Str("finish_reason")
	if fin == "" {
		fin = "stop"
	}
	writeCompletion(res, it.parsed.Str("model"), true, msg, fin, j.Obj("usage"))
	return &Result{Status: 200, Metrics: obs.Finish(true)}
}

// ---------------- Build ----------------
func (a *App) forwardBuild(ctx context.Context, t *Ticket, it *Item) (result *Result) {
	b := a.build
	spec := it.plan.Build
	b.mu.Lock()
	held, hasHeld := b.reservations[t.ID]
	delete(b.reservations, t.ID)
	b.mu.Unlock()
	var reserved int64
	if hasHeld && held.account == t.Account {
		reserved = held.n
	}
	app := b.AppFor(t.Account)
	b.mu.Lock()
	b.inc("requests", 1)
	b.mu.Unlock()
	t0 := nowMs()
	defer func() {
		b.free(t.ID)
		b.ledger.Release(t.Account, reserved)
		var u *Usage
		st := 0
		if result != nil {
			st = result.Status
			if result.Metrics != nil {
				u = result.Metrics.Usage
			}
		}
		var total *int64
		if u != nil && u.Total != nil {
			total = u.Total
		} else if u != nil && u.Input != nil && u.Output != nil {
			total = i64p(*u.Input + *u.Output)
		}
		var charged int64
		if total != nil {
			b.ledger.Charge(t.Account, *total, spec.Requested, u.Input, u.Output, u.Cached)
			charged = *total
			b.mu.Lock()
			b.inc("charged", *total)
			b.mu.Unlock()
		} else if st == 200 {
			b.mu.Lock()
			b.inc("missingUsage", 1)
			b.mu.Unlock()
			b.ledger.Charge(t.Account, reserved, spec.Requested, nil, nil, nil)
			charged = reserved
		} else {
			b.ledger.Fail(t.Account)
		}
		nn := func(p *int64) any {
			if p == nil {
				return nil
			}
			return *p
		}
		var in, out, ca any
		if u != nil {
			in, out, ca = nn(u.Input), nn(u.Output), nn(u.Cached)
		}
		b.ledger.Log(NewObj().Set("at", nowMs()).Set("account", t.Account).Set("model", spec.Requested).Set("status", st).Set("ms", nowMs()-t0).
			Set("input", in).Set("output", out).Set("cached", ca).Set("charged", charged).Set("estimated", total == nil))
		if st == 429 {
			b.ledger.Defer(t.Account, nowMs()+60000)
		}
		if st == 403 {
			b.mu.Lock()
			b.denied[itoa(t.Account)+"|"+spec.Model] = nowMs() + 6*3600000
			b.mu.Unlock()
			errf("[Build] #%d refused %s; skipped for 6h", t.Account, spec.Model)
		}
		if st >= 400 {
			b.mu.Lock()
			b.inc("rejected", 1)
			b.mu.Unlock()
		}
		if app != "" {
			a.scheduleRenew(t.Account, 0)
		}
	}()
	if app == "" {
		it.res.JSON(503, NewObj().Set("error", NewObj().Set("message", "账号 #"+itoa(t.Account)+" 没有 Build 项目").Set("code", "build_app_missing")), nil)
		return &Result{Status: 503}
	}
	parsed := it.parsed.Clone()
	raw := spec.Prefix == "build-st/"
	if raw {
		m := parsed.Arr("messages")
		ok := len(m) == 1 && asObj(m[0]).Str("role") == "user"
		if ok {
			c, isStr := asObj(m[0]).V("content").(string)
			ok = isStr && strings.HasPrefix(c, WIRE_PREFIX)
		}
		if !ok {
			b.mu.Lock()
			b.inc("rejected", 1)
			b.mu.Unlock()
			it.res.JSON(400, NewObj().Set("error", NewObj().Set("message", "build-st/ 只接收酒馆 build-standalone 插件打包好的请求，这条请求没有经过插件处理（插件未启用或没接管）。请启用插件，或改用 bridge/ 前缀由网关拆分。").Set("code", "build_st_plugin_required")), nil)
			return &Result{Status: 400}
		}
	}
	bs := NewObj().Set("app", app).Set("model", spec.Model).Set("thinking", spec.Thinking)
	if raw {
		bs.Set("keepMedia", true)
	}
	if spec.Prefix == "code/" {
		bs.Set("mode", "code")
	}
	if b.doc.Uses(spec.Prefix) {
		bs.Set("document", documentName())
		b.doc.mu.Lock()
		b.doc.requests++
		b.doc.mu.Unlock()
	}
	if !raw && spec.Prefix != "code/" {
		if env := b.presets.Apply(parsed.Arr("messages")); env != "" {
			parsed.Set("messages", []any{NewObj().Set("role", "user").Set("content", env)})
			b.mu.Lock()
			b.inc("presetHits", 1)
			b.mu.Unlock()
		}
	}
	parsed.Set("__build", bs)
	it2 := *it
	it2.parsed = parsed
	return a.forwardHeadless(ctx, t, &it2, nil)
}

func (a *App) buildCall(ctx context.Context, t *Ticket, it *Item, email string, _ []byte) *Result {
	res := it.res
	parsed := it.parsed
	spec := parsed.Obj("__build")
	stream := parsed.V("stream") == true
	obs := NewMetrics(stream)
	res.mu.Lock()
	res.tap = obs
	res.mu.Unlock()
	done := func(r *Result) *Result { r.Metrics = obs.Finish(!r.Cancelled); return r }
	fail := func(status int, msg, code string, h map[string]string) *Result {
		typ := "invalid_request_error"
		if status >= 500 {
			typ = "upstream_error"
		}
		res.JSON(status, NewObj().Set("error", NewObj().Set("message", msg).Set("type", typ).Set("code", code)), h)
		return done(&Result{Status: status})
	}
	model := spec.Str("model")
	thinking := int(num64(spec.V("thinking")))
	app := spec.Str("app")
	if !reAPP.MatchString(app) || !inStrs(model, buildBases...) || thinking < 1 || thinking > 3 {
		return fail(400, "Build 通道参数无效", "build_error", nil)
	}
	var packed *Packed
	var toolSpec *ToolSpec
	nonce := toolNonce()
	err := func() error {
		maxOut := 0
		mv := parsed.V("max_completion_tokens")
		if mv == nil {
			mv = parsed.V("max_tokens")
		}
		if n, ok := asSafeInt(mv); ok && n > 0 {
			maxOut = int(n)
		}
		var e error
		toolSpec, e = toolsNormalize(parsed.Obj("__tools"))
		if e != nil {
			return e
		}
		msgs := toolsFlatten(parsed.Arr("messages"))
		prep, e := bPrepare(msgs, spec.V("keepMedia") == true, spec.Str("mode"))
		if e != nil {
			return e
		}
		extra, e := toolsInstructions(toolSpec, nonce)
		if e != nil {
			return e
		}
		doc := spec.Str("document")
		if !reDocName.MatchString(doc) {
			doc = ""
		}
		packed, e = bPack(prep, maxOut, extra, spec.Str("mode") == "code", doc)
		return e
	}()
	if err != nil {
		if be, ok := err.(*BuildErr); ok {
			return fail(be.Status, be.Msg, be.Code, nil)
		}
		return fail(400, err.Error(), "build_context_invalid", nil)
	}
	t0 := nowMs()
	r := callBuild(ctx, a.svc.Raw, email, packed.Parts, model, thinking, app, 600*time.Second)
	logf("[HL-Build] #%d %s t%d %s bytes=%d stage=%s status=%d tries=%d resent=%d polls=%d ms=%d", t.Account, model, thinking, packed.Mode, packed.Bytes, r.stage, r.s, r.tries, r.resent, r.polls, nowMs()-t0)
	if ctx.Err() != nil || r.s == 499 {
		res.Destroy()
		return done(&Result{Cancelled: true})
	}
	if r.stage != "stream" || r.s != 200 {
		st := 502
		if inInts(r.s, 400, 403, 404, 413, 429) {
			st = r.s
		} else if r.s == 503 {
			st = 503
		}
		var h map[string]string
		if r.s == 429 {
			h = map[string]string{"Retry-After": "60"}
		}
		return fail(st, "Build 上游错误 ("+r.stage+" "+itoa(r.s)+")："+clipRunes(r.t, 300), "build_upstream_"+itoa(r.s), h)
	}
	out := parseBuild(r.t)
	if !out.OK {
		writeSimple("/tmp/build-last-parsefail.txt", []byte(r.t), 0600)
		if out.UpstreamFailed {
			payload := NewObj().Set("error", NewObj().Set("message", "谷歌拒绝生成这条请求（"+out.Error+"）。通常是输入内容触发了谷歌的内容审查，同样的内容重试也会失败，请修改输入内容（例如改写最新消息、删减近期聊天记录或世界书条目）后重试。").
				Set("type", "invalid_request_error").Set("code", "build_input_rejected"))
			return done(&Result{Status: 400, Rejection: jsonRejection(400, payload, "", map[string]string{"x-ais-build-retry": "upstream_failed"})})
		}
		return fail(502, "Build 回复解析失败："+out.Error, "build_parse_failed", nil)
	}
	if !out.Complete || strings.TrimSpace(out.Text) == "" {
		writeSimple("/tmp/build-last-incomplete.txt", []byte(r.t), 0600)
		return fail(502, "Build 回复不完整（未收到结束标记或正文为空），请重试", "build_incomplete", nil)
	}
	if packed.Document != "" {
		why := "no_file"
		if hash := docFindHash(r.t, packed.Document); hash != "" {
			text, n, e := buildReadFile(ctx, a.svc.Raw, email, app, hash)
			if e == "" && strings.TrimSpace(text) != "" {
				logf("[HL-BuildDoc] file used bytes=%d chat=%d", n, jsLen(out.Text))
				out.Text, why = text, ""
			} else if e != "" {
				why = "read_" + e
			} else {
				why = "read_200"
			}
		}
		if why != "" {
			errf("[HL-BuildDoc] fallback to chat reason=%s chat=%d", why, jsLen(out.Text))
			if docIsAck(out.Text) {
				return fail(502, "抗截断回复文件读取失败（"+why+"），聊天正文里也没有内容，请重试", "build_document_missing", nil)
			}
		}
	}
	usage := openaiUsage(out.Usage)
	content, calls, rejected := toolsExtract(out.Text, toolSpec, nonce)
	if toolSpec != nil {
		rj := ""
		if len(rejected) > 0 {
			rj = " rejected=" + itoa(len(rejected))
		}
		logf("[HL-BuildTools] tools=%d calls=%d%s", len(toolSpec.Tools), len(calls), rj)
	}
	msg := NewObj().Set("role", "assistant")
	if len(calls) > 0 && strings.TrimSpace(content) == "" {
		msg.Set("content", nil)
	} else {
		msg.Set("content", content)
	}
	finish := "stop"
	if len(calls) > 0 {
		msg.Set("tool_calls", calls)
		finish = "tool_calls"
	}
	if out.Thought != "" {
		msg.Set("reasoning_content", out.Thought)
	}
	writeCompletion(res, it.model, stream, msg, finish, usage)
	return done(&Result{Status: 200})
}

// Build: fresh project after every request (never blocks the response).
func (a *App) scheduleRenew(acct, attempt int) {
	if a.cfg.V("buildRenewPerRequest") == false {
		return
	}
	a.renewMu.Lock()
	if a.renewing[acct] {
		a.renewMu.Unlock()
		return
	}
	a.renewing[acct] = true
	a.renewMu.Unlock()
	delay := 2 * time.Second
	if attempt > 0 {
		delay = 10 * time.Second
	}
	time.AfterFunc(delay, func() {
		a.renewMu.Lock()
		delete(a.renewing, acct)
		a.renewMu.Unlock()
		if a.build.Busy(acct) > 0 {
			if attempt < 60 {
				a.scheduleRenew(acct, attempt+1)
			}
			return
		}
		r := a.rotation.Renew(acct, a.acc.Email(acct))
		if !strings.HasPrefix(r, "renewed") && r != "no_project" && r != "changed" {
			if attempt < 60 {
				a.scheduleRenew(acct, attempt+1)
			} else {
				errf("[BuildRenew] #%d gave up: %s", acct, r)
			}
		}
	})
}