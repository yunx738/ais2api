package main

// anti-truncation/<model> on the no-browser backend (headless-at.js, at-plain.js, at-prompt-store.js).
import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const AT_TOOL = "seal_final_reply"

var atNames = []string{"seal_final_reply", "final_answer", "emit_answer"}

const (
	atMaxAttempts = 3
	atMaxRetries  = 3
	atDeadlineMs  = 960000
	atStopMin     = 2000
	atEmptyDelay  = 3000
)

type atPreset struct{ desc, hint, cont string }

// ---- prompt store (at-prompt.json) ----
type AtPromptStore struct {
	mu       sync.Mutex
	file     string
	value    string
	custom   *Obj
	defaults *Obj
	presets  []any
}

var atKeys = []string{"classic", "once", "tool_only", "lite", "custom"}
var atLimits = map[string]int{"desc": 1000, "hint": 6000, "cont": 2000}

func NewAtPromptStore(file, defaultsFile string) (*AtPromptStore, error) {
	raw, err := readJSONFile(defaultsFile)
	if err != nil || asObj(raw) == nil {
		return nil, errors.New("at-prompt-defaults.json unreadable")
	}
	s := &AtPromptStore{file: file, value: "classic", defaults: asObj(raw)}
	labels := [][3]string{
		{"classic", "原版", "原来的提示词，只要求用工具交答案"},
		{"once", "只交一次（推荐）", "明确要求只用工具交一次，不许再用正文写一遍，也不许把调用写成文字"},
		{"tool_only", "只许工具调用", "回复里除了这一次工具调用不许有任何文字，最严格"},
		{"lite", "精简", "一句话版本，占用最少的提示词"},
		{"custom", "自定义", "用下面编辑框里的内容；{tool} 会换成工具名，{partial} 是续写时上一轮没交完的内容"},
	}
	for _, l := range labels {
		p := NewObj().Set("key", l[0]).Set("label", l[1]).Set("note", l[2])
		if d := s.defaults.Obj("presets").Obj(l[0]); d != nil {
			p.Set("desc", d.V("desc")).Set("hint", d.V("hint")).Set("cont", s.defaults.V("cont"))
		}
		s.presets = append(s.presets, p)
	}
	if r, err := readJSONFile(file); err == nil {
		if d := asObj(r); d != nil {
			if c := d.Obj("custom"); c != nil {
				if v, err := s.validCustom(c); err == nil {
					s.custom = v
				}
			}
			p := d.Str("preset")
			if inStrs(p, atKeys...) && (p != "custom" || s.custom != nil) {
				s.value = p
			}
		}
	}
	return s, nil
}

func (s *AtPromptStore) validCustom(c *Obj) (*Obj, error) {
	if c == nil {
		return nil, herr(400, "自定义提示词格式不对")
	}
	out := NewObj()
	for _, k := range []string{"desc", "hint", "cont"} {
		v, ok := c.Get(k)
		if !ok && k == "cont" {
			v = s.defaults.V("cont")
		}
		str, isStr := v.(string)
		if !isStr {
			return nil, herr(400, k+" 必须是文字")
		}
		if jsLen(str) > atLimits[k] {
			return nil, herr(400, k+" 太长（最多 "+itoa(atLimits[k])+" 字）")
		}
		out.Set(k, strings.ReplaceAll(str, "\r\n", "\n"))
	}
	if strings.TrimSpace(out.Str("desc")) == "" {
		return nil, herr(400, "工具说明（desc）不能为空")
	}
	if strings.TrimSpace(out.Str("hint")) == "" {
		return nil, herr(400, "系统提示词（hint）不能为空")
	}
	if len(MarshalJS(out)) > 8000 {
		return nil, herr(400, "自定义提示词总共太长（最多约 8000 字节）")
	}
	return out, nil
}

func (s *AtPromptStore) getL() string {
	if inStrs(s.value, atKeys...) && (s.value != "custom" || s.custom != nil) {
		return s.value
	}
	return "classic"
}
func (s *AtPromptStore) Preset() atPreset {
	s.mu.Lock()
	defer s.mu.Unlock()
	fill := func(t string) string { return strings.ReplaceAll(t, "{tool}", AT_TOOL) }
	key := s.getL()
	if key == "custom" && s.custom != nil {
		cont := s.custom.Str("cont")
		if cont == "" {
			cont = s.defaults.Str("cont")
		}
		return atPreset{fill(s.custom.Str("desc")), fill(s.custom.Str("hint")), cont}
	}
	p := s.defaults.Obj("presets").Obj(key)
	if p == nil {
		p = s.defaults.Obj("presets").Obj("classic")
	}
	return atPreset{fill(p.Str("desc")), fill(p.Str("hint")), s.defaults.Str("cont")}
}
func (s *AtPromptStore) Set(b *Obj) (*Obj, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := b.Str("preset")
	if !inStrs(v, atKeys...) {
		return nil, herr(400, "提示词只能是 "+strings.Join(atKeys, "、")+" 之一")
	}
	custom := s.custom
	if c, ok := b.Get("custom"); ok && c != nil {
		x, err := s.validCustom(asObj(c))
		if err != nil {
			return nil, err
		}
		custom = x
	}
	if v == "custom" && custom == nil {
		return nil, herr(400, "选“自定义”前先填写自定义提示词")
	}
	var cj any
	if custom != nil {
		cj = custom
	}
	if err := writeAtomic(s.file, MarshalJS(NewObj().Set("preset", v).Set("custom", cj)), 0600, true); err != nil {
		return nil, err
	}
	s.value, s.custom = v, custom
	return s.statusL(), nil
}
func (s *AtPromptStore) Import(b *Obj) (*Obj, error) {
	var d *Obj
	if b.Str("format") == "ais2api-at-prompt" {
		d = b
	} else if _, ok := b.V("hint").(string); ok {
		d = NewObj().Set("preset", "custom").Set("custom", b)
	}
	if d == nil {
		return nil, herr(400, "不是防截断提示词导出文件")
	}
	p := d.Str("preset")
	if !inStrs(p, atKeys...) {
		p = "custom"
	}
	return s.Set(NewObj().Set("preset", p).Set("custom", d.V("custom")))
}
func (s *AtPromptStore) Export() *Obj {
	s.mu.Lock()
	defer s.mu.Unlock()
	var c any = s.custom
	if s.custom == nil {
		once := s.defaults.Obj("presets").Obj("once")
		c = NewObj().Set("desc", once.V("desc")).Set("hint", once.V("hint")).Set("cont", s.defaults.V("cont"))
	}
	return NewObj().Set("format", "ais2api-at-prompt").Set("version", 1).Set("exportedAt", time.Now().UTC().Format("2006-01-02T15:04:05.000Z")).
		Set("preset", s.getL()).Set("custom", c)
}
func (s *AtPromptStore) Status() *Obj { s.mu.Lock(); defer s.mu.Unlock(); return s.statusL() }
func (s *AtPromptStore) statusL() *Obj {
	var c any
	if s.custom != nil {
		c = s.custom
	}
	return NewObj().Set("preset", s.getL()).Set("default", "classic").Set("presets", s.presets).Set("custom", c).
		Set("limits", NewObj().Set("desc", 1000).Set("hint", 6000).Set("cont", 2000).Set("bytes", 8000)).
		Set("placeholders", NewObj().Set("tool", "工具名 seal_final_reply").Set("partial", "续写时：上一轮没交完的内容（没有就为空）"))
}

func atDefaultsPath() string {
	if p := os.Getenv("AT_DEFAULTS"); p != "" {
		return p
	}
	return filepath.Join(dualRoot(), "refactor", "at-prompt-defaults.json")
}

// ---- loop ----
func atInject(body *Obj, p atPreset) *Obj {
	b := body.Clone()
	b.Set("stream", false)
	b.Del("stream_options")
	tools := []any{}
	for _, t := range b.Arr("tools") {
		if inStrs(asObj(t).Obj("function").Str("name"), atNames...) {
			continue
		}
		tools = append(tools, t)
	}
	tools = append(tools, NewObj().Set("type", "function").Set("function", NewObj().Set("name", AT_TOOL).Set("description", p.desc).
		Set("parameters", NewObj().Set("type", "object").Set("properties", NewObj().Set("answer", NewObj().Set("type", "string"))).Set("required", []any{"answer"}))))
	b.Set("tools", tools)
	msgs := append([]any(nil), b.Arr("messages")...)
	idx := -1
	for i, m := range msgs {
		if asObj(m).Str("role") == "system" {
			idx = i
			break
		}
	}
	if idx >= 0 {
		if c, ok := asObj(msgs[idx]).V("content").(string); ok {
			mm := asObj(msgs[idx]).Clone()
			mm.Set("content", c+"\n\n"+p.hint)
			msgs[idx] = mm
		} else {
			msgs = append([]any{NewObj().Set("role", "system").Set("content", p.hint)}, msgs...)
		}
	} else {
		msgs = append([]any{NewObj().Set("role", "system").Set("content", p.hint)}, msgs...)
	}
	b.Set("messages", msgs)
	capped := false
	for _, k := range []string{"max_tokens", "max_completion_tokens"} {
		if n, ok := asSafeInt(b.V(k)); ok {
			if n > 32768 {
				b.Set(k, int64(32768))
			}
			capped = true
		}
	}
	if !capped {
		b.Set("max_tokens", int64(32768))
	}
	return b
}

type atX struct {
	found     bool
	answer    string
	finish    string
	plain     string
	calls     []any
	reasoning string
}

func atExtract(r *Obj) atX {
	var c *Obj
	if a := r.Arr("choices"); len(a) > 0 {
		c = asObj(a[0])
	}
	m := c.Obj("message")
	x := atX{finish: c.Str("finish_reason")}
	x.calls = m.Arr("tool_calls")
	for _, tc := range x.calls {
		f := asObj(tc).Obj("function")
		if !inStrs(f.Str("name"), atNames...) {
			continue
		}
		args := f.Str("arguments")
		if args == "" {
			args = "{}"
		}
		if a, err := ParseObj([]byte(args)); err == nil {
			if s, ok := a.V("answer").(string); ok {
				x.answer, x.found = s, true
			}
		}
	}
	x.plain, _ = m.V("content").(string)
	x.reasoning = jsStr(m.V("reasoning_content"))
	if !truthy(m.V("reasoning_content")) {
		x.reasoning = ""
	}
	return x
}

type atSum struct {
	complete                  bool
	prompt, completion, total *int64
	cached, reasoning         *int64
}

func addp(p **int64, v int64) {
	if *p == nil {
		*p = new(int64)
	}
	**p += v
}
func (s *atSum) add(u *Obj) {
	if u == nil {
		s.complete = false
		return
	}
	if n, ok := asCount(u.V("prompt_tokens")); ok {
		addp(&s.prompt, n)
	}
	if n, ok := asCount(u.V("completion_tokens")); ok {
		addp(&s.completion, n)
	}
	if n, ok := asCount(u.V("total_tokens")); ok {
		addp(&s.total, n)
	}
	if n, ok := asSafeInt(u.Obj("prompt_tokens_details").V("cached_tokens")); ok {
		addp(&s.cached, n)
	}
	if n, ok := asSafeInt(u.Obj("completion_tokens_details").V("reasoning_tokens")); ok {
		addp(&s.reasoning, n)
	}
}
func (s *atSum) out() *Obj {
	if !s.complete || s.prompt == nil {
		return nil
	}
	var comp int64
	if s.completion != nil {
		comp = *s.completion
	}
	tot := *s.prompt + comp
	if s.total != nil && *s.total != 0 {
		tot = *s.total
	}
	u := NewObj().Set("prompt_tokens", *s.prompt).Set("completion_tokens", comp).Set("total_tokens", tot)
	if s.cached != nil {
		u.Set("prompt_tokens_details", NewObj().Set("cached_tokens", *s.cached))
	}
	if s.reasoning != nil {
		u.Set("completion_tokens_details", NewObj().Set("reasoning_tokens", *s.reasoning))
	}
	return u
}

type atResult struct {
	ok        bool
	answer    string
	reasoning string
	usage     *Obj
	rounds    int
	status    int
	payload   *Obj
	upstream  bool
	retryAfter string
	cancelled bool
}

func atErr(status int, typ, st, msg string, usage *Obj) *Obj {
	p := NewObj().Set("error", NewObj().Set("code", status).Set("type", typ).Set("status", st).Set("message", msg))
	if usage != nil {
		p.Set("usage", usage)
	}
	return p
}

func atRun(ctx context.Context, call func(*Obj) *CallResult, body *Obj, p atPreset) atResult {
	base := atInject(body, p)
	t0 := nowMs()
	sum := &atSum{complete: true}
	attempt, retries := 0, 0
	cur := base
	lastPartial := ""
	first := true
	for {
		if ctx.Err() != nil {
			return atResult{status: 499, cancelled: true}
		}
		r := call(cur)
		if r.Status != 200 {
			if first {
				pl := r.JSON
				if pl == nil {
					pl = NewObj().Set("error", NewObj().Set("message", clipRunes(string(r.Text), 500)))
				}
				return atResult{status: r.Status, upstream: true, retryAfter: r.RetryAfter(), payload: pl}
			}
			msg := r.JSON.Obj("error").Str("message")
			if msg == "" {
				msg = string(r.Text)
			}
			return atResult{status: 502, payload: atErr(502, "upstream_incomplete", "CONTINUATION_"+itoa(r.Status), "续写请求失败（"+itoa(r.Status)+"）："+clipRunes(msg, 200), nil)}
		}
		first = false
		sum.add(r.JSON.Obj("usage"))
		attempt++
		x := atExtract(r.JSON)
		elapsed := nowMs() - t0
		seal := "no"
		if x.found {
			seal = "yes(" + itoa(jsLen(x.answer)) + ")"
		}
		fin := x.finish
		if fin == "" {
			fin = "-"
		}
		logf("[HL-AT] round %d finish=%s seal=%s plain=%d calls=%d ms=%d", attempt, fin, seal, jsLen(x.plain), len(x.calls), elapsed)
		if x.found && x.finish != "content_filter" && (x.finish == "stop" || x.finish == "tool_calls" || strings.TrimSpace(x.answer) != "") {
			return atResult{ok: true, answer: x.answer, reasoning: x.reasoning, usage: sum.out(), rounds: attempt}
		}
		if !x.found && x.finish == "stop" && len(x.calls) == 0 && jsLen(strings.TrimSpace(x.plain)) >= atStopMin {
			ans, _ := atCleanPlainAnswer(x.plain)
			return atResult{ok: true, answer: ans, reasoning: x.reasoning, usage: sum.out(), rounds: attempt}
		}
		u := sum.out()
		if x.finish == "content_filter" {
			var uu *Obj
			if u != nil {
				uu = NewObj().Set("prompt_tokens", u.V("prompt_tokens"))
			}
			return atResult{status: 502, payload: atErr(502, "content_blocked", "SAFETY", "上游内容安全拦截：模型拒绝生成，本次没有输出。这类拦截有时是误判，可以直接重试；多次被拦请调整内容。", uu)}
		}
		resend := false
		if !x.found && x.plain == "" && len(x.calls) == 0 && elapsed < atDeadlineMs && retries < atMaxRetries {
			retries++
			resend = true
			logf("[HL-AT] empty reply; resending original %d/%d", retries, atMaxRetries)
			select {
			case <-ctx.Done():
			case <-time.After(atEmptyDelay * time.Millisecond):
			}
		}
		if !resend && (attempt >= atMaxAttempts || elapsed >= atDeadlineMs) {
			chars := jsLen(x.answer)
			if jsLen(x.plain) > chars {
				chars = jsLen(x.plain)
			}
			late := elapsed >= atDeadlineMs
			f := x.finish
			if f == "" {
				f = "NO_ANSWER"
			}
			var msg, st string
			if late {
				msg = "已用时约 " + itoa(int(math.Floor(float64(elapsed)/60000+0.5))) + " 分钟仍未得到完整答案，超过 16 分钟不再续写，直接返回失败。已生成约 " + itoa(chars) + " 字被丢弃，可重试。"
				st = "AT_TIME_LIMIT"
			} else {
				msg = "上游中途结束（finish=" + f + "），未返回内容。已生成约 " + itoa(chars) + " 字被丢弃，可重试。"
				st = "FINISH_" + strings.ToUpper(f)
			}
			var uu *Obj
			if u != nil {
				uu = NewObj().Set("prompt_tokens", u.V("prompt_tokens")).Set("completion_tokens", u.V("completion_tokens"))
			}
			return atResult{status: 502, payload: atErr(502, "upstream_incomplete", st, msg, uu)}
		}
		if resend {
			attempt, cur, lastPartial = 0, base, ""
			continue
		}
		prev := x.plain
		if x.answer != "" && jsLen(x.answer) >= jsLen(x.plain) {
			prev = x.answer
		}
		if prev != "" {
			lastPartial = prev
		}
		msgs := append([]any(nil), cur.Arr("messages")...)
		var m *Obj
		if a := r.JSON.Arr("choices"); len(a) > 0 {
			m = asObj(a[0]).Obj("message")
		}
		tcs := m.Arr("tool_calls")
		if truthy(m.V("content")) || len(tcs) > 0 {
			am := NewObj().Set("role", "assistant")
			if truthy(m.V("content")) {
				am.Set("content", m.V("content"))
			} else {
				am.Set("content", nil)
			}
			if len(tcs) > 0 {
				am.Set("tool_calls", tcs)
			}
			msgs = append(msgs, am)
			for _, tc := range tcs {
				msgs = append(msgs, NewObj().Set("role", "tool").Set("tool_call_id", asObj(tc).V("id")).Set("content", `{"status":"incomplete"}`))
			}
		}
		partial := ""
		if lastPartial != "" {
			partial = "Previous partial answer: " + lastPartial + "\n\n"
		}
		cont := strings.ReplaceAll(strings.ReplaceAll(p.cont, "{tool}", AT_TOOL), "{partial}", partial)
		msgs = append(msgs, NewObj().Set("role", "user").Set("content", cont))
		cur = cur.Clone()
		cur.Set("messages", msgs)
		cur.Del("max_tokens")
		cur.Del("max_completion_tokens")
		logf("[HL-AT] continuing (attempt %d/%d)", attempt+1, atMaxAttempts)
	}
}

// ---- at-plain.js ----
var reATCall = regexp.MustCompile(`(?:◁[^▷\n]{0,24}▷\s*)?(?:` + "`{3}" + `[a-z]*\s*)?(?:\[\s*)?(?:\{\s*"name"\s*:\s*"(?:seal_final_reply|final_answer|emit_answer)"\s*,\s*"(?:arguments|args|parameters)"\s*:\s*)?(?:\b(?:(?:seal_final_reply|final_answer|emit_answer)|print\(default_api\.(?:seal_final_reply|final_answer|emit_answer)|default_api\.(?:seal_final_reply|final_answer|emit_answer))\s*\(?\s*)?\{\s*"answer"\s*:\s*"|\b(?:seal_final_reply|final_answer|emit_answer)\s*\(\s*answer\s*=\s*"`)
var reHex4 = regexp.MustCompile(`^[0-9a-fA-F]{4}$`)

func atDecodeJSONString(src string, i int) (string, int) {
	var out []uint16
	j := i + 1
	for j < len(src) {
		ch := src[j]
		if ch == '"' {
			return string(utf16.Decode(out)), j + 1
		}
		if ch == '\\' && j+1 < len(src) {
			e := src[j+1]
			switch e {
			case 'n':
				out = append(out, '\n')
			case 't':
				out = append(out, '\t')
			case 'r':
				out = append(out, '\r')
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case 'u':
				if j+6 <= len(src) && reHex4.MatchString(src[j+2:j+6]) {
					var v uint16
					for _, c := range src[j+2 : j+6] {
						v <<= 4
						switch {
						case c >= '0' && c <= '9':
							v |= uint16(c - '0')
						case c >= 'a' && c <= 'f':
							v |= uint16(c-'a') + 10
						default:
							v |= uint16(c-'A') + 10
						}
					}
					out = append(out, v)
					j += 4
				} else {
					out = append(out, 'u')
				}
			default:
				r, size := utf8.DecodeRuneInString(src[j+1:])
				out = append(out, utf16.Encode([]rune{r})...)
				j += size - 1
			}
			j += 2
			continue
		}
		r, size := utf8.DecodeRuneInString(src[j:])
		out = append(out, utf16.Encode([]rune{r})...)
		j += size
	}
	return string(utf16.Decode(out)), -1
}

func atCleanPlainAnswer(plain string) (string, string) {
	literalNl := strings.Count(plain, `\n`)
	if loc := reATCall.FindStringIndex(plain); loc != nil {
		q := loc[1] - 1
		dec, end := atDecodeJSONString(plain, q)
		before := strings.TrimRight(plain[:loc[0]], " \t\r\n\f\v")
		bt := jsLen(strings.TrimSpace(before))
		dt := jsLen(strings.TrimSpace(dec))
		if end < 0 && bt > dt {
			return before, "cut-before-call"
		}
		if float64(dt) >= math.Max(200, float64(bt)*0.5) {
			return dec, "decoded-call"
		}
		if bt > 0 {
			return before, "cut-before-call"
		}
	}
	if literalNl >= 10 {
		k := strings.Index(plain, `\n`)
		st := strings.LastIndex(plain[:k+1], "\n")
		if st < 0 {
			st = 0
		} else {
			st++
		}
		head := strings.TrimRight(plain[:st], " \t\r\n\f\v")
		tail := plain[st:]
		tailNl := strings.Count(tail, `\n`)
		if jsLen(strings.TrimSpace(head)) >= 1000 && tailNl >= 10 && float64(len(strings.Split(tail, "\n"))) <= 3+float64(tailNl)/50 {
			return head, "cut-escaped-tail"
		}
	}
	return plain, "as-is"
}