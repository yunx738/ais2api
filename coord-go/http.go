package main

// coordinator-http.js + the actions of start-headless.js.
import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var sanitizeMu sync.Mutex
var sanitizeRepaired, sanitizeRejected int64
var sanitizeLast, sanitizeParams any

func sanitizeStatsJSON() *Obj {
	sanitizeMu.Lock()
	defer sanitizeMu.Unlock()
	o := NewObj().Set("repaired", sanitizeRepaired).Set("rejected", sanitizeRejected).Set("lastRejected", sanitizeLast)
	if sanitizeParams != nil {
		o.Set("lastParams", sanitizeParams)
	}
	return o
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	w.Write(MarshalJS(body))
}
func errBody(msg string) *Obj { return NewObj().Set("error", msg) }

func readBody(r *http.Request, max int64) (*Obj, error) {
	b, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return nil, herr(400, "Invalid JSON body")
	}
	if int64(len(b)) > max {
		return nil, herr(413, "Body too large")
	}
	o, err := ParseObj(b)
	if err != nil {
		if _, e2 := ParseJSON(b); e2 == nil {
			return nil, herr(400, "JSON object required")
		}
		return nil, herr(400, "Invalid JSON body")
	}
	return o, nil
}

var reJSONCT = regexp.MustCompile(`(?i)^application/json(?:\s*;|$)`)
var reNative = regexp.MustCompile(`^/v1beta/models/([^/:]+):(generateContent|streamGenerateContent)$`)
var reBuildPrefix = regexp.MustCompile(`^(build(-st)?|bridge|code)/`)

func codeIn(err error, codes ...int) int {
	s := statusOf(err)
	if inInts(s, codes...) {
		return s
	}
	return 0
}

func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if p := recover(); p != nil {
			errf("[HTTP] panic %v", p)
			func() { defer func() { recover() }(); writeJSON(w, 503, errBody("Coordinator unavailable")) }()
		}
	}()
	path := r.URL.Path
	supplied := r.Header.Get("x-goog-api-key")
	if supplied == "" {
		if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
			supplied = h[7:]
		}
	}
	if supplied == "" {
		supplied = r.Header.Get("x-api-key")
	}
	if supplied == "" {
		supplied = r.URL.Query().Get("key")
	}
	internal := strings.HasPrefix(path, "/internal/")
	ok := false
	if internal {
		ok = a.auth.IsInternal(supplied)
	} else {
		ok = a.auth.Allows(supplied, true)
	}
	if supplied == "" || !ok {
		writeJSON(w, 401, errBody("Unauthorized"))
		return
	}
	if r.Method == "GET" && path == "/v1/models" {
		data := []any{}
		ids := a.routing.List()
		if a.build.settings.enabled() {
			ids = append(ids, buildModels()...)
		}
		for _, id := range ids {
			data = append(data, NewObj().Set("id", id).Set("object", "model").Set("owned_by", "google"))
		}
		writeJSON(w, 200, NewObj().Set("object", "list").Set("data", data))
		return
	}
	if internal {
		a.internal(w, r)
		return
	}
	native := reNative.FindStringSubmatch(path)
	if r.Method != "POST" || (path != "/v1/chat/completions" && native == nil) {
		writeJSON(w, 404, errBody("Endpoint unavailable"))
		return
	}
	if !reJSONCT.MatchString(r.Header.Get("Content-Type")) {
		writeJSON(w, 415, errBody("JSON required"))
		return
	}
	a.generate(w, r, native)
}

// ---------------- generation ----------------
func (a *App) generate(w http.ResponseWriter, r *http.Request, native []string) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 20*1024*1024+1))
	if err != nil {
		return
	}
	if len(body) > 20*1024*1024 {
		writeJSON(w, 413, errBody("Request too large"))
		return
	}
	parsed, err := ParseObj(body)
	if err != nil {
		if _, e2 := ParseJSON(body); e2 == nil {
			writeJSON(w, 400, errBody("JSON object required"))
		} else {
			writeJSON(w, 400, errBody("Invalid JSON"))
		}
		return
	}
	route := r.URL.Path
	it := &Item{route: route, native: native != nil, parsed: parsed}
	// model + account pin (suffix or header)
	var model string
	if native != nil {
		model = native[1]
		if v, has := parsed.Get("model"); has && v != nil && jsStr(v) != model {
			writeJSON(w, 400, errBody("Invalid request model"))
			return
		}
		it.stream = native[2] == "streamGenerateContent"
		q := r.URL.Query()
		q.Del("key")
		it.query = q.Encode()
	} else {
		m, isStr := parsed.V("model").(string)
		if !isStr || m == "" {
			writeJSON(w, 400, errBody("Invalid request model"))
			return
		}
		model = m
		it.stream = parsed.V("stream") == true
	}
	base, pin, group := splitPin(model)
	if h := strings.TrimSpace(r.Header.Get("X-AIS-Account")); h != "" && pin == 0 {
		pin, _ = strconv.Atoi(strings.TrimPrefix(h, "#"))
	}
	if h := strings.TrimSpace(r.Header.Get("X-AIS-Group")); h != "" && group == "" && pin == 0 {
		group = h
	}
	if pin < 0 {
		pin = 0
	}
	it.pin, it.group, it.model = pin, group, base
	if !it.native {
		parsed.Set("model", base)
	}
	if strings.HasPrefix(base, "build-") || base == "" {
		// never let clients reach internal build-* plan names directly
	}
	// Build channel: tool fields -> __tools, response_format dropped; client internals never trusted.
	if !it.native && reBuildPrefix.MatchString(base) {
		for _, k := range []string{"__tools", "__build", "__tcprobe"} {
			parsed.Del(k)
		}
		tools := NewObj()
		for _, k := range []string{"tools", "tool_choice", "functions", "function_call", "parallel_tool_calls"} {
			if v, has := parsed.Get(k); has {
				tools.Set(k, v)
				parsed.Del(k)
			}
		}
		parsed.Del("response_format")
		if !strings.HasPrefix(base, "bridge/") && (len(tools.Arr("tools")) > 0 || len(tools.Arr("functions")) > 0) {
			parsed.Set("__tools", tools)
		}
	}
	_, notes, serr := sanitizeRequest(route, parsed)
	if serr != nil {
		sanitizeMu.Lock()
		sanitizeRejected++
		sanitizeLast = NewObj().Set("at", nowMs()).Set("reason", serr.Error())
		sanitizeMu.Unlock()
		errf("[Gateway] rejected before upstream: %s", serr.Error())
		msg := "请求未发送到上游，网关无法自动修复：" + serr.Error()
		if it.native {
			writeJSON(w, 400, NewObj().Set("error", NewObj().Set("code", 400).Set("status", "INVALID_ARGUMENT").Set("message", msg)))
		} else {
			writeJSON(w, 400, NewObj().Set("error", NewObj().Set("message", msg).Set("type", "invalid_request_error").Set("code", "gateway_unfixable_request")))
		}
		return
	}
	if len(notes) > 0 {
		sanitizeMu.Lock()
		sanitizeRepaired++
		n := notes
		if len(n) > 8 {
			n = n[:8]
		}
		sanitizeParams = NewObj().Set("at", nowMs()).Set("fixes", toAny(n))
		sanitizeMu.Unlock()
		logf("[Gateway] params adjusted: %s", strings.Join(notes, "; "))
	}
	it.body = MarshalJS(parsed)
	// Early stream: anti-truncation and Build answer only at the end, fake mode buffers on purpose.
	if it.stream {
		_, isBuild := parseBuildModel(base)
		buildModel := isBuild == nil && reBuildPrefix.MatchString(base)
		switch {
		case !it.native && (strings.HasPrefix(base, AT_PREFIX) || buildModel):
			it.soft = "openai"
		case a.stream.Get() == "fake" && !it.native:
			it.soft = "openai"
		case a.stream.Get() == "fake" && it.native:
			if r.URL.Query().Get("alt") == "sse" {
				it.soft = "gemini-sse"
			} else {
				it.soft = "gemini-array"
			}
		}
	}
	res := NewResp(w, r)
	it.res = res
	a.sch.Submit(it)
	<-res.done
}

// ---------------- internal API ----------------
func (a *App) internal(w http.ResponseWriter, r *http.Request) {
	path, m := r.URL.Path, r.Method
	ctJSON := reJSONCT.MatchString(r.Header.Get("Content-Type"))
	fail := func(err error, keep []int, fallback string) {
		if c := codeIn(err, keep...); c != 0 {
			writeJSON(w, c, errBody(err.Error()))
			return
		}
		writeJSON(w, 503, errBody(fallback))
	}
	switch {
	case m == "GET" && path == "/internal/coordinator-status":
		writeJSON(w, 200, a.status())
		return
	case m == "GET" && (path == "/internal/requests" || path == "/internal/usage"):
		q, err := ParseHistQuery(r.URL.Query(), path == "/internal/usage")
		if err != nil {
			writeJSON(w, 400, errBody("Invalid analytics filters"))
			return
		}
		var out *Obj
		if path == "/internal/requests" {
			out, err = a.hist.List(q)
		} else {
			out, err = a.hist.Summary(q)
		}
		if err != nil {
			writeJSON(w, 503, errBody("Analytics unavailable"))
			return
		}
		writeJSON(w, 200, out.Set("recording", a.health.JSON(a.hist)))
		return
	case strings.HasPrefix(path, "/internal/console-auth"):
		a.consoleAuth(w, r)
		return
	case path == "/internal/proxies" && m == "GET":
		writeJSON(w, 200, NewObj().Set("slots", []any{}).Set("headless", true))
		return
	case (path == "/internal/proxies" || path == "/internal/proxies/apply") && m == "POST":
		if !ctJSON {
			writeJSON(w, 415, errBody("JSON required"))
			return
		}
		writeJSON(w, 503, errBody("代理操作未确认，请重新读取状态"))
		return
	case m == "POST" && path == "/internal/models/policy":
		b, err := readBody(r, 4096)
		if err != nil {
			writeJSON(w, statusOr(err, 400), errBody(err.Error()))
			return
		}
		rev, okr := asSafeInt(b.V("revision"))
		at, okb := b.V("antiTruncation").(bool)
		model, okm := b.V("model").(string)
		if !okm || !okr || rev < 0 || !inStrs(b.Str("quotaFamily"), "flash", "pro", "ultra") || !okb {
			writeJSON(w, 400, errBody("Invalid model policy"))
			return
		}
		a.mu.Lock()
		busy := len(a.sch.queue) > 0 || len(a.sch.executing) > 0
		a.mu.Unlock()
		if busy {
			writeJSON(w, 409, NewObj().Set("saved", false).Set("reason", "requests_or_operations_busy"))
			return
		}
		snap, err := a.policies.Set(model, b.Str("quotaFamily"), at, rev)
		if err != nil {
			if statusOf(err) == 409 {
				writeJSON(w, 409, errBody("Policy revision changed; refresh first"))
			} else {
				writeJSON(w, 503, errBody("Policy save not confirmed; refresh before retry"))
			}
			return
		}
		out := NewObj().Set("saved", true)
		for _, k := range snap.Keys() {
			out.Set(k, snap.V(k))
		}
		writeJSON(w, 200, out)
		return
	case m == "GET" && path == "/internal/models":
		a.routing.Refresh()
		ms := []any{}
		for _, id := range a.routing.Models() {
			ms = append(ms, NewObj().Set("id", id).Set("methods", []any{"generateContent"}))
		}
		writeJSON(w, 200, NewObj().Set("slots", NewObj().Set(SLOT, NewObj().Set("account", nil).Set("catalog", NewObj().Set("snapshot", NewObj().Set("models", ms))))).
			Set("errors", NewObj()).Set("generationRoutingIntegrated", true).Set("configuredPolicies", a.policies.Size()).Set("policyState", a.policies.Snapshot()))
		return
	case m == "GET" && path == "/internal/prices":
		writeJSON(w, 200, a.prices.Snapshot().Set("models", toAny(a.policies.Sorted())))
		return
	case m == "POST" && path == "/internal/prices":
		if !ctJSON {
			writeJSON(w, 415, errBody("JSON required"))
			return
		}
		b, err := readBody(r, 4096)
		if err != nil {
			writeJSON(w, 400, errBody("Invalid JSON body"))
			return
		}
		if _, has := a.policies.Lookup(b.Str("model")); !has {
			writeJSON(w, 400, errBody("Invalid price configuration"))
			return
		}
		snap, err := a.prices.Set(b)
		if err != nil {
			switch statusOf(err) {
			case 409:
				writeJSON(w, 409, errBody("Price revision changed; refresh first"))
			case 400:
				writeJSON(w, 400, errBody("Invalid price configuration"))
			default:
				writeJSON(w, 503, errBody("Price save not confirmed; refresh before retry"))
			}
			return
		}
		writeJSON(w, 200, snap.Set("models", toAny(a.policies.Sorted())))
		return
	case m == "POST" && path == "/internal/models/refresh":
		b, err := readBody(r, 4096)
		if err != nil || !inStrs(b.Str("slot"), "A", "B", "H") {
			writeJSON(w, 400, errBody("Invalid slot"))
			return
		}
		a.routing.Refresh()
		writeJSON(w, 202, NewObj().Set("accepted", true).Set("models", a.routing.Size()))
		return
	case m == "POST" && path == "/internal/set-mode":
		b, err := readBody(r, 4096)
		if err != nil || !inStrs(b.Str("mode"), "fake", "real") {
			writeJSON(w, 400, errBody("Invalid mode"))
			return
		}
		if err := a.stream.Set(b.Str("mode")); err != nil {
			writeJSON(w, 503, errBody("保存未确认"))
			return
		}
		logf("[Coordinator] streaming mode -> %s", b.Str("mode"))
		writeJSON(w, 200, NewObj().Set("mode", b.Str("mode")).Set("results", NewObj().Set(SLOT, NewObj().Set("mode", b.Str("mode")).Set("applied", true))))
		return
	case m == "POST" && path == "/internal/rotate":
		if !ctJSON {
			writeJSON(w, 415, errBody("JSON required"))
			return
		}
		writeJSON(w, 409, NewObj().Set("started", []any{}).Set("skipped", []any{NewObj().Set("slot", SLOT).Set("reason", "无浏览器模式下所有账号同时可用，无需切换")}))
		return
	case m == "POST" && path == "/internal/restart":
		b, err := readBody(r, 4096)
		if err != nil || !inStrs(b.Str("slot"), "A", "B", "H") {
			writeJSON(w, 400, errBody("Invalid slot"))
			return
		}
		if _, err := run(30*time.Second, "systemctl", "restart", "ais2api-headless"); err != nil {
			writeJSON(w, 409, NewObj().Set("started", []any{}).Set("skipped", []any{NewObj().Set("slot", SLOT).Set("reason", err.Error())}))
			return
		}
		writeJSON(w, 202, NewObj().Set("started", []any{SLOT}).Set("skipped", []any{}))
		return
	case m == "POST" && path == "/internal/accounts/delete":
		if !ctJSON {
			writeJSON(w, 415, errBody("JSON required"))
			return
		}
		b, err := readBody(r, 4096)
		var out *Obj
		if err == nil {
			out, err = a.deleteAccount(b)
		}
		if err != nil {
			fail(err, []int{400, 404, 409, 413}, "删除未确认，请刷新状态后核对")
			return
		}
		writeJSON(w, 200, out)
		return
	case path == "/internal/accounts/verify":
		if m == "GET" {
			id, _ := strconv.Atoi(r.URL.Query().Get("id"))
			var f any
			a.mu.Lock()
			if fl := a.core.Flag(id); fl != nil {
				f = fl.Str("status")
			}
			a.mu.Unlock()
			writeJSON(w, 200, NewObj().Set("job", nil).Set("flag", f))
			return
		}
		if m == "POST" {
			b, err := readBody(r, 4096)
			if err != nil {
				writeJSON(w, statusOr(err, 503), errBody(err.Error()))
				return
			}
			id, _ := asSafeInt(b.V("id"))
			res := "not_imported"
			if a.importer.Has(int(id)) {
				res = "ok"
			}
			writeJSON(w, 202, NewObj().Set("id", id).Set("state", "done").Set("result", res))
			return
		}
	case m == "POST" && path == "/internal/accounts/revalidate":
		b, err := readBody(r, 4096)
		var out *Obj
		if err == nil {
			out, err = a.revalidate(b)
		}
		if err != nil {
			fail(err, []int{400, 409}, "恢复未确认")
			return
		}
		writeJSON(w, 200, out)
		return
	case m == "GET" && path == "/internal/client-script":
		b, err := os.ReadFile(filepath.Join(a.root, "refactor", "black-browser.js"))
		if err != nil {
			writeJSON(w, 503, errBody("脚本不可用"))
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(b)
		return
	case path == "/internal/target-app":
		if m == "GET" {
			writeJSON(w, 200, NewObj().Set("headless", true))
			return
		}
		if m == "POST" {
			writeJSON(w, 409, errBody("无浏览器模式下没有实例，此操作不可用"))
			return
		}
	case m == "GET" && path == "/internal/build-status":
		writeJSON(w, 200, a.build.Status().Set("appletRotation", a.rotation.Status()))
		return
	case path == "/internal/build/settings":
		if m == "GET" {
			writeJSON(w, 200, a.build.settings.Status())
			return
		}
		b, err := readBody(r, 4096)
		var out *Obj
		if err == nil {
			out, err = a.build.settings.Set(b)
		}
		if err != nil {
			writeJSON(w, statusOr(err, 500), errBody(err.Error()))
			return
		}
		writeJSON(w, 200, out)
		return
	case path == "/internal/build/document":
		if m == "GET" {
			writeJSON(w, 200, a.build.doc.Status())
			return
		}
		b, err := readBody(r, 4096)
		var out *Obj
		if err == nil {
			out, err = a.build.doc.Set(b)
		}
		if err != nil {
			writeJSON(w, statusOr(err, 500), errBody(err.Error()))
			return
		}
		writeJSON(w, 200, out)
		return
	case path == "/internal/build/presets":
		if m == "GET" {
			writeJSON(w, 200, NewObj().Set("presets", a.build.presets.List()))
			return
		}
		b, err := readBody(r, 4*1024*1024)
		if err != nil {
			if statusOf(err) == 413 {
				writeJSON(w, 413, errBody("预设文件超过 4MB"))
			} else {
				writeJSON(w, 400, errBody(err.Error()))
			}
			return
		}
		var out *Obj
		switch b.Str("action") {
		case "add":
			out, err = a.build.presets.Add(b.V("name"), b.V("preset"))
		case "remove":
			out, err = a.build.presets.Remove(jsStr(b.V("id")))
		case "enable":
			out, err = a.build.presets.SetEnabled(jsStr(b.V("id")), b.V("enabled"))
		default:
			writeJSON(w, 400, errBody("未知操作"))
			return
		}
		if err != nil {
			writeJSON(w, statusOr(err, 500), errBody(err.Error()))
			return
		}
		writeJSON(w, 200, out)
		return
	case m == "POST" && path == "/internal/build/rotate-applets":
		b, _ := readBody(r, 4096)
		only := 0
		if n, ok := asSafeInt(b.V("account")); ok {
			only = int(n)
		}
		writeJSON(w, 200, a.rotation.Tick(true, only))
		return
	case m == "GET" && path == "/internal/usage-counts":
		out, err := a.hist.Counts(a.acc.Tier)
		if err != nil {
			writeJSON(w, 503, errBody(err.Error()))
			return
		}
		writeJSON(w, 200, out)
		return
	case m == "POST" && path == "/internal/accounts/name":
		b, err := readBody(r, 4096)
		var out *Obj
		if err == nil {
			out, err = a.withPoolID(b, func(id int) (*Obj, error) { return a.acc.SetAlias(id, b.V("name")) })
		}
		if err != nil {
			fail(err, []int{400, 404, 409}, "保存未确认")
			return
		}
		writeJSON(w, 200, out)
		return
	case path == "/internal/ultra-mode" && m == "GET":
		writeJSON(w, 200, a.acc.Status(a.core.Ids))
		return
	case (path == "/internal/ultra-mode" || path == "/internal/accounts/tier") && m == "POST":
		b, err := readBody(r, 4096)
		var out *Obj
		if err == nil {
			if path == "/internal/ultra-mode" {
				if err = a.acc.SetMode(b); err == nil {
					out = a.acc.Status(a.core.Ids)
				}
			} else {
				out, err = a.withPoolID(b, func(id int) (*Obj, error) { return a.acc.SetTier(id, b.Str("tier")) })
			}
		}
		if err != nil {
			fail(err, []int{400, 404, 409}, "保存未确认")
			return
		}
		writeJSON(w, 200, out)
		return
	case path == "/internal/concurrency":
		if m == "GET" {
			writeJSON(w, 200, NewObj().Set("A", a.perAcc).Set("B", a.perAcc).Set("perAccount", a.perAcc).Set("headless", true))
			return
		}
		writeJSON(w, 503, errBody("保存未确认"))
		return
	case path == "/internal/at-prompt/export" && m == "GET":
		writeJSON(w, 200, a.atPrompt.Export())
		return
	case path == "/internal/at-prompt/import" && m == "POST":
		b, err := readBody(r, 32768)
		var out *Obj
		if err == nil {
			out, err = a.atPrompt.Import(b)
		}
		if err != nil {
			switch statusOf(err) {
			case 400:
				writeJSON(w, 400, errBody(err.Error()))
			case 413:
				writeJSON(w, 413, errBody("文件太大"))
			default:
				writeJSON(w, 503, errBody("保存未确认"))
			}
			return
		}
		writeJSON(w, 200, out)
		return
	case path == "/internal/at-prompt":
		if m == "GET" {
			writeJSON(w, 200, a.atPrompt.Status())
			return
		}
		b, err := readBody(r, 32768)
		var out *Obj
		if err == nil {
			out, err = a.atPrompt.Set(b)
		}
		if err != nil {
			fail(err, []int{400}, "保存未确认")
			return
		}
		writeJSON(w, 200, out)
		return
	case path == "/internal/run-mode":
		if m == "GET" {
			writeJSON(w, 200, runModeStatus())
			return
		}
		b, err := readBody(r, 4096)
		if err != nil {
			fail(err, []int{400, 409}, "切换未确认")
			return
		}
		mode := b.Str("mode")
		if mode == "" {
			if s, ok := b.V("single").(bool); ok {
				mode = map[bool]string{true: "single", false: "dual"}[s]
			}
		}
		next, err := runModeWrite(a.root, mode)
		if err != nil {
			fail(err, []int{400, 409}, "切换未确认")
			return
		}
		phase := "headless"
		if next.Str("mode") != "headless" {
			logf("[Coordinator] run mode -> %s; restarting", next.Str("mode"))
			scheduleCoordinatorRestart("ais2api-mode-switch-")
			phase = "restarting"
		}
		writeJSON(w, 200, runModeStatus().Set("mode", next.Str("mode")).Set("phase", phase))
		return
	case path == "/internal/browser-lease":
		if m == "GET" {
			writeJSON(w, 200, NewObj().Set("lease", nil))
			return
		}
		b, err := readBody(r, 4096)
		if err != nil {
			writeJSON(w, 503, errBody("实例暂停或恢复未确认"))
			return
		}
		switch b.Str("action") {
		case "acquire":
			writeJSON(w, 200, NewObj().Set("slot", nil).Set("account", nil).Set("single", false).Set("headless", true))
		case "release":
			writeJSON(w, 200, NewObj().Set("released", true))
		default:
			writeJSON(w, 400, errBody("Invalid action"))
		}
		return
	case strings.HasPrefix(path, "/internal/ops/"):
		a.ops(w, r, path[len("/internal/ops/"):])
		return
	case m == "POST" && path == "/internal/sync-accounts":
		out, err := a.syncAccounts()
		if err != nil {
			writeJSON(w, 503, errBody("Coordinator unavailable"))
			return
		}
		writeJSON(w, 200, out)
		return
	}
	writeJSON(w, 404, errBody("Endpoint unavailable"))
}

func statusOr(err error, def int) int {
	if s := statusOf(err); s != 0 {
		return s
	}
	return def
}

func (a *App) withPoolID(b *Obj, fn func(int) (*Obj, error)) (*Obj, error) {
	n, ok := asNum(b.V("id"))
	if s, isStr := b.V("id").(string); isStr {
		f, err := strconv.ParseFloat(s, 64)
		n, ok = f, err == nil
	}
	id := int(n)
	a.mu.Lock()
	in := ok && float64(id) == n && a.core.InPool(id)
	a.mu.Unlock()
	if !in {
		return nil, herr(404, "账号 "+jsStr(b.V("id"))+" 不在账号池")
	}
	return fn(id)
}

func (a *App) consoleAuth(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if r.Method == "GET" && path == "/internal/console-auth" {
		writeJSON(w, 200, a.auth.Status())
		return
	}
	if r.Method != "POST" {
		writeJSON(w, 404, errBody("Not found"))
		return
	}
	b, err := readBody(r, 4096)
	var out *Obj
	if err == nil {
		switch path {
		case "/internal/console-auth/login":
			out = NewObj().Set("ok", a.auth.VerifyLogin(b.V("secret")))
		case "/internal/console-auth/password":
			out, err = a.auth.SetPassword(b.V("current"), b.V("next"))
		case "/internal/console-auth/keys":
			out, err = a.auth.CreateKey(b.V("name"))
		case "/internal/console-auth/key":
			out, err = a.auth.UpdateKey(jsStr(b.V("id")), b.V("disabled"), b.V("remove") == true)
		case "/internal/console-auth/internal":
			out, err = a.auth.SetInternalExternal(b.V("enabled") == true)
		default:
			writeJSON(w, 404, errBody("Not found"))
			return
		}
	}
	if err != nil {
		if c := codeIn(err, 400, 403, 404, 413); c != 0 {
			writeJSON(w, c, errBody(err.Error()))
		} else {
			writeJSON(w, 500, errBody("保存失败"))
		}
		return
	}
	writeJSON(w, 200, out)
}

// ---------------- ops ----------------
func (a *App) ops(w http.ResponseWriter, r *http.Request, op string) {
	if r.Method == "GET" && op == "overview" {
		o := opsOverview(filepath.Join(a.root, "refactor"))
		writeJSON(w, 200, o.Set("backups", opsBackups()).Set("coordinator", a.opsStatus()))
		return
	}
	if r.Method == "GET" && op == "logs" {
		n, _ := strconv.Atoi(r.URL.Query().Get("n"))
		lines, err := opsLogs(r.URL.Query().Get("source"), n)
		if err != nil {
			writeJSON(w, 400, errBody(err.Error()))
			return
		}
		writeJSON(w, 200, NewObj().Set("source", r.URL.Query().Get("source")).Set("lines", lines))
		return
	}
	if r.Method != "POST" {
		writeJSON(w, 404, errBody("当前模式不支持此操作"))
		return
	}
	b, err := readBody(r, 4096)
	if err != nil {
		writeJSON(w, statusOr(err, 400), errBody(err.Error()))
		return
	}
	var out *Obj
	switch op {
	case "restart":
		out, err = opsRestartUnit(b.Str("unit"))
	case "backup":
		out, err = opsBackup()
	case "clear-cooldown":
		out, err = a.withPoolID(b, a.clearCooldown)
	case "reset-quota":
		out, err = a.withPoolID(b, func(id int) (*Obj, error) { return a.resetQuota(id, b.Str("confirm")) })
	case "write-back":
		a.mu.Lock()
		ids := a.liveIDs()
		a.mu.Unlock()
		out = a.importer.WriteBack(ids)
	case "headless-concurrency":
		out, err = a.setConcurrency(b.V("perAccount"))
	case "pause":
		out, err = a.setPaused(b.V("paused"))
	case "account-enable":
		out, err = a.withPoolID(b, func(id int) (*Obj, error) { return a.setEnabled(id, b.V("enabled")) })
	case "account-schedule":
		out, err = a.withPoolID(b, func(id int) (*Obj, error) {
			res, e := a.sched.Set(id, b)
			if e == nil {
				logf("[Ops] account #%d schedule %s", id, MarshalJS(res))
				a.sch.Pump()
			}
			return res, e
		})
	case "stream-mode":
		mode := b.Str("mode")
		if !inStrs(mode, "fake", "real") {
			err = herr(400, "流模式只能是 fake 或 real")
		} else if err = a.stream.Set(mode); err == nil {
			logf("[Ops] streaming mode -> %s", mode)
			out = NewObj().Set("mode", mode)
		}
	case "test-account":
		out, err = a.withPoolID(b, a.testAccount)
	case "cancel-request":
		out, err = a.cancelRequest(jsStr(b.V("id")))
	default:
		writeJSON(w, 404, errBody("当前模式不支持此操作"))
		return
	}
	if err != nil {
		if c := codeIn(err, 400, 404, 409, 413); c != 0 {
			writeJSON(w, c, errBody(err.Error()))
		} else {
			writeJSON(w, 503, errBody("操作未确认"))
		}
		return
	}
	writeJSON(w, 200, out)
}

func (a *App) clearCooldown(id int) (*Obj, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.core.ClearCooldown(id)
	n := 0
	if acc := a.core.account(id, false); acc != nil {
		for _, q := range acc.models {
			if q.CooldownUntil != 0 {
				q.CooldownUntil = 0
				n++
			}
		}
	}
	a.core.Checkpoint()
	logf("[Ops] cooldown cleared #%d", id)
	go a.sch.Pump()
	return NewObj().Set("id", id).Set("cleared", true).Set("models", n), nil
}
func (a *App) resetQuota(id int, confirm string) (*Obj, error) {
	if confirm != "RESET "+itoa(id) {
		return nil, herr(400, "确认文字不匹配")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	n := 0
	if acc := a.core.account(id, false); acc != nil {
		for _, q := range acc.models {
			if q.Used != 0 {
				q.Used = 0
				n++
			}
		}
	}
	a.core.Checkpoint()
	logf("[Ops] quota counters reset #%d", id)
	go a.sch.Pump()
	return NewObj().Set("id", id).Set("reset", n), nil
}
func (a *App) setConcurrency(v any) (*Obj, error) {
	n, ok := asSafeInt(v)
	if !ok || n < 1 || n > 10 {
		return nil, herr(400, "并发数只能是 1 到 10 的整数")
	}
	if err := writeSimple(a.ccFile, MarshalJS(NewObj().Set("perAccount", n)), 0600); err != nil {
		return nil, err
	}
	a.mu.Lock()
	a.perAcc = int(n)
	a.mu.Unlock()
	logf("[Headless] per-account concurrency -> %d", n)
	go a.sch.Pump()
	return NewObj().Set("perAccount", n), nil
}
func (a *App) setPaused(v any) (*Obj, error) {
	p, ok := v.(bool)
	if !ok {
		return nil, herr(400, "参数无效")
	}
	a.mu.Lock()
	a.disp.paused = p
	a.mu.Unlock()
	logf("[Ops] dispatch %s", map[bool]string{true: "paused", false: "resumed"}[p])
	if !p {
		a.sch.Pump()
	}
	return NewObj().Set("paused", p), nil
}
func (a *App) setEnabled(id int, v any) (*Obj, error) {
	en, ok := v.(bool)
	if !ok {
		return nil, herr(400, "参数无效")
	}
	a.mu.Lock()
	if en {
		delete(a.disp.disabled, id)
	} else {
		a.disp.disabled[id] = true
	}
	list := intsAny(sortedInts(a.disp.disabled))
	enabled := !a.disp.disabled[id]
	a.mu.Unlock()
	if err := writeSimple(a.disFile, MarshalJS(list), 0600); err != nil {
		return nil, err
	}
	logf("[Ops] account #%d %s", id, map[bool]string{true: "enabled", false: "disabled"}[en])
	if en {
		a.sch.Pump()
	}
	return NewObj().Set("id", id).Set("enabled", enabled), nil
}
func (a *App) testAccount(id int) (*Obj, error) {
	email := a.acc.Email(id)
	if email == "" || !a.importer.Has(id) {
		return nil, herr(409, "账号未导入无浏览器服务")
	}
	pick := ""
	for _, m := range []string{"gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"} {
		if a.routing.Has(m) {
			pick = m
			break
		}
	}
	if pick == "" {
		bad := regexp.MustCompile(`image|tts|search|live|audio`)
		for _, m := range a.routing.Models() {
			if strings.Contains(m, "flash") && !bad.MatchString(m) {
				pick = m
				break
			}
		}
	}
	if pick == "" {
		return nil, herr(409, "模型列表为空，请先刷新模型")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	t0 := nowMs()
	r := a.svc.Call(ctx, email, "POST", "/v1/chat/completions", NewObj().Set("model", pick).
		Set("messages", []any{NewObj().Set("role", "user").Set("content", "Reply with the single word OK.")}).Set("stream", false))
	ms := nowMs() - t0
	if r.Err != nil {
		st, msg := 502, clipRunes(r.Err.Error(), 200)
		if ctx.Err() != nil {
			st, msg = 504, "30 秒未响应"
		}
		return NewObj().Set("id", id).Set("model", pick).Set("ok", false).Set("status", st).Set("ms", ms).Set("error", msg), nil
	}
	text := ""
	if c := r.JSON.Arr("choices"); len(c) > 0 {
		text = clipRunes(strings.TrimSpace(jsStr(asObj(c[0]).Obj("message").V("content"))), 80)
	}
	logf("[Ops] test #%d %s status=%d ms=%d", id, pick, r.Status, ms)
	var e any
	if r.Status == 200 {
		if text == "" {
			e = "返回为空"
		}
	} else {
		msg := r.JSON.Obj("error").Str("message")
		if msg == "" {
			msg = string(r.Text)
		}
		e = clipRunes(msg, 200)
	}
	return NewObj().Set("id", id).Set("model", pick).Set("ok", r.Status == 200 && text != "").Set("status", r.Status).Set("ms", ms).Set("text", text).Set("error", e), nil
}
func (a *App) cancelRequest(id string) (*Obj, error) {
	a.mu.Lock()
	x := a.disp.live[id]
	a.mu.Unlock()
	if x == nil {
		return nil, herr(404, "请求已结束或不存在")
	}
	x.res.Destroy()
	logf("[Ops] request cancelled %s #%d", clip(id, 8), x.ticket.Account)
	return NewObj().Set("id", id).Set("cancelled", true), nil
}

func (a *App) revalidate(b *Obj) (*Obj, error) {
	id64, ok := asSafeInt(b.V("id"))
	id := int(id64)
	a.mu.Lock()
	defer a.mu.Unlock()
	if !ok || !a.core.InPool(id) {
		return nil, herr(400, "账号无效")
	}
	f := a.core.Flag(id)
	if f == nil {
		return NewObj().Set("revalidated", false).Set("id", id), nil
	}
	if f.Str("status") != "invalid" {
		return nil, herr(409, "账号状态不允许恢复")
	}
	a.core.SetFlag(id, nil)
	a.core.ClearCooldown(id)
	a.core.Checkpoint()
	go a.reloadSoon()
	return NewObj().Set("revalidated", true).Set("id", id), nil
}

var reEmailDir = regexp.MustCompile(`^[^/]+@[^/]+$`)

func (a *App) deleteAccount(b *Obj) (*Obj, error) {
	id64, ok := asSafeInt(b.V("id"))
	id := int(id64)
	if !ok || id < 1 || b.Str("confirm") != "DELETE "+itoa(id) {
		return nil, herr(400, "删除确认不匹配")
	}
	a.mu.Lock()
	c := a.core
	if !c.InPool(id) {
		a.mu.Unlock()
		return nil, herr(404, "账号 "+itoa(id)+" 不在账号池")
	}
	if c.Deleted(id) {
		a.mu.Unlock()
		return NewObj().Set("deleted", true).Set("id", id), nil
	}
	if a.stopping || c.Halted || a.disp.busy(id) > 0 || a.build.Busy(id) > 0 {
		a.mu.Unlock()
		return nil, herr(409, "账号正在处理请求，请稍后再删除")
	}
	email := a.acc.Email(id)
	f := c.Flag(id)
	if f == nil {
		f = NewObj().Set("status", "deleting").Set("reason", "login_required").Set("at", nowMs())
	}
	f.Set("status", "deleting")
	c.SetFlag(id, f)
	c.Checkpoint()
	if err := os.Remove(a.acc.file(id)); err != nil && !os.IsNotExist(err) {
		a.mu.Unlock()
		return nil, err
	}
	if email != "" && reEmailDir.MatchString(email) {
		os.RemoveAll(filepath.Join(a.importer.target, email))
	}
	f.Set("status", "deleted").Set("deletedAt", nowMs())
	c.Checkpoint()
	a.mu.Unlock()
	removeLoginCredential(id)
	a.build.forget(id)
	a.rotation.forget(id)
	go a.reloadSoon()
	return NewObj().Set("deleted", true).Set("id", id).Set("historyPreserved", true), nil
}

// login-credentials.js remove(id): drop the stored encrypted password of a deleted account.
func removeLoginCredential(id int) {
	file := "/opt/ais2api-direct/credentials.json"
	b, err := os.ReadFile(file)
	if err != nil {
		return
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(b, &m) != nil {
		return
	}
	if _, ok := m[itoa(id)]; !ok {
		return
	}
	o, err := ParseObj(b)
	if err != nil {
		return
	}
	o.Del(itoa(id))
	writeAtomic(file, MarshalJS(o), 0600, true)
}