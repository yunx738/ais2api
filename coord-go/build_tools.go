package main

// build-tools.js (text tool protocol), build-response.js (generation parse), build-document.js (reply file).
import (
	"regexp"
	"strings"
)

// ---------------- tools ----------------
type BTool struct {
	Name, Description string
	Parameters        any
}
type ToolSpec struct {
	Tools    []BTool
	Mode     string
	Name     string
	Parallel bool
}

var reBToolName = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

func toolErr(status int, msg string) *BuildErr { return &BuildErr{status, msg, "build_tools_invalid"} }

func toolsNormalize(spec *Obj) (*ToolSpec, error) {
	if spec == nil {
		return nil, nil
	}
	var list []BTool
	add := func(f *Obj) error {
		n, ok := f.V("name").(string)
		if f == nil || !ok || !reBToolName.MatchString(n) {
			return toolErr(400, "工具名称无效："+clipRunes(jsString(f.V("name")), 60))
		}
		for _, t := range list {
			if t.Name == n {
				return toolErr(400, "工具名称重复："+n)
			}
		}
		var params any = asObj(f.V("parameters"))
		if asObj(f.V("parameters")) == nil {
			params = NewObj().Set("type", "object").Set("properties", NewObj())
		}
		d, _ := f.V("description").(string)
		list = append(list, BTool{n, d, params})
		return nil
	}
	for _, t := range spec.Arr("tools") {
		if to := asObj(t); to.Str("type") == "function" && to.Obj("function") != nil {
			if err := add(to.Obj("function")); err != nil {
				return nil, err
			}
		}
	}
	for _, f := range spec.Arr("functions") {
		if err := add(asObj(f)); err != nil {
			return nil, err
		}
	}
	if len(list) == 0 {
		return nil, nil
	}
	if len(list) > 128 {
		return nil, toolErr(400, "工具最多 128 个")
	}
	ts := &ToolSpec{Tools: list, Mode: "auto", Parallel: spec.V("parallel_tool_calls") != false}
	c, has := spec.Get("tool_choice")
	if !has {
		c = spec.V("function_call")
	}
	if s, ok := c.(string); ok {
		if s == "none" {
			ts.Mode = "none"
		} else if s == "required" || s == "any" {
			ts.Mode = "required"
		}
	} else if co := asObj(c); co != nil {
		n := co.Obj("function").Str("name")
		if n == "" {
			n = co.Str("name")
		}
		found := false
		for _, t := range list {
			found = found || t.Name == n
		}
		if !found {
			return nil, toolErr(400, "指定的工具不存在："+clipRunes(n, 60))
		}
		ts.Mode, ts.Name = "named", n
	}
	return ts, nil
}

func toolNonce() string { return randHexN(4) }

func toolsInstructions(spec *ToolSpec, n string) (string, error) {
	if spec == nil || spec.Mode == "none" {
		return "", nil
	}
	t := "tool_call_" + n
	defs := []any{}
	for _, x := range spec.Tools {
		o := NewObj().Set("name", x.Name)
		if x.Description != "" {
			o.Set("description", x.Description)
		}
		defs = append(defs, o.Set("parameters", x.Parameters))
	}
	body := string(MarshalJS(defs))
	if len(body) > 256*1024 {
		return "", toolErr(413, "工具定义超过 256 KiB")
	}
	rule := map[string]string{"auto": "Call a tool only when it is needed; otherwise answer normally without any tool block.",
		"required": "You must call at least one tool in this reply.",
		"named":    "You must call the tool \"" + spec.Name + "\" in this reply."}[spec.Mode]
	par := " Use at most one block."
	if spec.Parallel {
		par = " Several blocks may follow each other."
	}
	return strings.Join([]string{"[FUNCTION TOOLS]",
		"The client application runs these functions on its own machine and sends back the results. They are not limited to this project workspace: when the user asks for something a function can do (files, commands, web, etc.), call it instead of refusing. Your built-in workspace (index.html, metadata.json, ...) is an unrelated sandbox: the user's real project and files are on the client and reachable only through these functions, so never answer from the sandbox or say a file does not exist without calling a function first. Definitions (JSON Schema parameters):",
		body,
		"To call a function, end your reply with one block per call, exactly in this form:",
		"<" + t + ">{\"name\":\"FUNCTION_NAME\",\"arguments\":{...}}</" + t + ">",
		"Rules: " + rule + par + " Put any normal text before the blocks. The JSON must be valid; arguments must match the schema. Do not invent results: stop after the blocks and wait for the client.",
		"Earlier calls appear in the history as [tool call ...] and [tool result ...] lines; only the <" + t + "> form above triggers a new call.",
		"[/FUNCTION TOOLS]"}, "\n"), nil
}

// OpenAI messages with tool history -> plain text messages.
func toolsFlatten(messages []any) []any {
	names := map[string]string{}
	out := make([]any, len(messages))
	for i, mv := range messages {
		out[i] = mv
		m := asObj(mv)
		if m == nil {
			continue
		}
		calls := m.Arr("tool_calls")
		if calls == nil && truthy(m.V("function_call")) {
			calls = []any{NewObj().Set("id", nil).Set("function", m.V("function_call"))}
		}
		if m.Str("role") == "assistant" && len(calls) > 0 {
			lines := toolCallLines(calls, names)
			text := ""
			if s, ok := m.V("content").(string); ok {
				text = s
			} else if a := m.Arr("content"); a != nil {
				var ts []string
				for _, p := range a {
					if t, ok := asObj(p).V("text").(string); ok {
						ts = append(ts, t)
					}
				}
				text = strings.Join(ts, "\n")
			}
			n := m.Clone()
			n.Del("tool_calls")
			n.Del("function_call")
			if strings.TrimSpace(text) != "" {
				text += "\n"
			}
			out[i] = n.Set("content", text+strings.Join(lines, "\n"))
			continue
		}
		if r := m.Str("role"); r == "tool" || r == "function" {
			id := m.Str("tool_call_id")
			nm := m.Str("name")
			if nm == "" {
				nm = names[id]
			}
			if nm == "" {
				nm = "?"
			}
			if id == "" {
				id = "-"
			}
			text, isStr := m.V("content").(string)
			if !isStr {
				text = string(MarshalJS(m.V("content")))
			}
			out[i] = NewObj().Set("role", "user").Set("name", "tool").Set("content", "[tool result id="+id+" name="+nm+"]\n"+text)
		}
	}
	return out
}

func toolsCheckArgs(schema any, args any) string {
	a := asObj(args)
	if a == nil {
		return "arguments 不是对象"
	}
	s := asObj(schema)
	if s == nil {
		return ""
	}
	for _, k := range s.Arr("required") {
		if ks, ok := k.(string); ok && !a.Has(ks) {
			return "缺少参数 " + ks
		}
	}
	props := s.Obj("properties")
	is := func(t string, v any) bool {
		switch t {
		case "string":
			_, ok := v.(string)
			return ok
		case "number":
			_, ok := asNum(v)
			return ok
		case "integer":
			f, ok := asNum(v)
			return ok && f == float64(int64(f))
		case "boolean":
			_, ok := v.(bool)
			return ok
		case "array":
			_, ok := v.([]any)
			return ok
		case "object":
			return asObj(v) != nil
		case "null":
			return v == nil
		}
		return false
	}
	for _, k := range a.Keys() {
		v := a.V(k)
		p := props.Obj(k)
		if p == nil {
			continue
		}
		var types []string
		switch t := p.V("type").(type) {
		case string:
			types = []string{t}
		case []any:
			for _, x := range t {
				types = append(types, jsString(x))
			}
		}
		if len(types) > 0 {
			ok := false
			for _, t := range types {
				ok = ok || is(t, v)
			}
			if !ok && !(v == nil && truthy(p.V("nullable"))) {
				return "参数 " + k + " 类型应为 " + strings.Join(types, "|")
			}
		}
		if en := p.Arr("enum"); en != nil {
			vj, ok := string(MarshalJS(v)), false
			for _, e := range en {
				ok = ok || string(MarshalJS(e)) == vj
			}
			if !ok {
				return "参数 " + k + " 不在可选值内"
			}
		}
	}
	return ""
}

var reFence = regexp.MustCompile("^```(?:json)?\\s*|\\s*```$")

// Model reply -> content, calls, rejected reasons. Only blocks carrying this request's nonce count.
func toolsExtract(text string, spec *ToolSpec, n string) (string, []any, []string) {
	if spec == nil || spec.Mode == "none" {
		return text, nil, nil
	}
	t := "tool_call_" + n
	re := regexp.MustCompile("<" + t + `>\s*([\s\S]*?)\s*</` + t + ">")
	known := map[string]BTool{}
	for _, x := range spec.Tools {
		known[x.Name] = x
	}
	var calls []any
	var rejected []string
	var kept strings.Builder
	at := 0
	for _, m := range re.FindAllStringSubmatchIndex(text, -1) {
		raw := reFence.ReplaceAllString(text[m[2]:m[3]], "")
		why := ""
		v, err := ParseObj([]byte(raw))
		if err != nil {
			why = "JSON 无效"
		}
		name, isStr := v.V("name").(string)
		if why == "" && !isStr {
			why = "缺少 name"
		}
		if why == "" {
			if _, ok := known[name]; !ok {
				why = "未知工具 " + name
			}
		}
		var args any
		if why == "" {
			if s, ok := v.V("arguments").(string); ok {
				if x, err := ParseJSON([]byte(s)); err == nil {
					args = x
				} else {
					why = "arguments 不是合法 JSON"
				}
			} else if x, ok := v.Get("arguments"); ok && x != nil {
				args = x
			} else if x, ok := v.Get("parameters"); ok && x != nil {
				args = x
			} else {
				args = NewObj()
			}
		}
		if why == "" {
			why = toolsCheckArgs(known[name].Parameters, args)
		}
		if why == "" && spec.Mode == "named" && name != spec.Name {
			why = "本轮只允许调用 " + spec.Name
		}
		if why == "" && !spec.Parallel && len(calls) > 0 {
			why = "本轮只允许一个调用"
		}
		kept.WriteString(text[at:m[0]])
		at = m[1]
		if why != "" {
			rejected = append(rejected, why)
			kept.WriteString(text[m[0]:m[1]])
			continue
		}
		calls = append(calls, NewObj().Set("id", "call_"+randHexN(9)).Set("type", "function").
			Set("function", NewObj().Set("name", name).Set("arguments", string(MarshalJS(args)))))
	}
	kept.WriteString(text[at:])
	if len(calls) == 0 {
		return text, nil, rejected
	}
	return strings.TrimRight(kept.String(), " \t\r\n\f\v"), calls, rejected
}

// ---------------- response parse ----------------
type BuildOut struct {
	OK, Complete, UpstreamFailed bool
	Error                        string
	Text, Thought, Model         string
	Usage                        *[3]int64 // uncached, output, cached
}

func bTurns(v any, d int, out *[][]any) {
	a, ok := v.([]any)
	if d > 6 || !ok {
		return
	}
	if len(a) > 0 {
		if a0, ok := a[0].([]any); ok && len(a0) > 0 {
			if a00, ok := a0[0].([]any); ok && len(a00) > 1 {
				if _, ok := a00[0].([]any); ok {
					if role, ok := a00[1].(string); ok && (role == "user" || role == "model") {
						for _, x := range a {
							if s, ok := x.(string); ok && strings.HasPrefix(s, "models/") {
								*out = append(*out, a)
								return
							}
						}
					}
				}
			}
		}
	}
	for _, x := range a {
		bTurns(x, d+1, out)
	}
}

func bUpstreamFailure(v any, d int) string {
	a, ok := v.([]any)
	if d > 6 || !ok {
		return ""
	}
	if len(a) > 5 && a[0] == nil {
		if f, ok := a[5].([]any); ok && len(f) > 0 {
			if s, ok := f[0].(string); ok {
				for _, x := range a {
					if m, ok := x.(string); ok && strings.HasPrefix(m, "models/") {
						return clipRunes(s, 300)
					}
				}
			}
		}
	}
	for _, x := range a {
		if h := bUpstreamFailure(x, d+1); h != "" {
			return h
		}
	}
	return ""
}

var reBuildErrCode = regexp.MustCompile(`\[\s*\d+\s*,\s*"([^"]{1,300})"\s*\]`)
var reDigitsOnly = regexp.MustCompile(`^\d+$`)

func parseBuild(raw string) BuildOut {
	J, err := ParseJSON([]byte(raw))
	if err != nil {
		return BuildOut{Error: "unparseable"}
	}
	var turns [][]any
	bTurns(J, 0, &turns)
	var last []any
	for _, t := range turns {
		if t[0].([]any)[0].([]any)[1] == "model" {
			last = t
		}
	}
	if last == nil {
		if f := bUpstreamFailure(J, 0); f != "" {
			return BuildOut{Error: f, UpstreamFailed: true}
		}
		if m := reBuildErrCode.FindStringSubmatch(raw); m != nil {
			return BuildOut{Error: m[1]}
		}
		return BuildOut{Error: "no model turn"}
	}
	out := BuildOut{OK: true}
	parts, _ := last[0].([]any)[0].([]any)[0].([]any)
	var text, thought strings.Builder
	for _, pv := range parts {
		p, ok := pv.([]any)
		if !ok || len(p) < 2 {
			continue
		}
		s, ok := p[1].(string)
		if !ok {
			continue
		}
		isThought := false
		if len(p) > 12 {
			if f, ok := asNum(p[12]); ok && f == 1 {
				isThought = true
			}
		}
		if isThought {
			thought.WriteString(s)
		} else {
			text.WriteString(s)
		}
	}
	out.Text, out.Thought = text.String(), thought.String()
	for i := len(last) - 1; i >= 0; i-- {
		u, ok := last[i].([]any)
		if !ok || (len(u) != 2 && len(u) != 3) {
			continue
		}
		all := true
		var n [3]int64
		for j, x := range u {
			s, ok := x.(string)
			if !ok || !reDigitsOnly.MatchString(s) {
				all = false
				break
			}
			v, _ := asCount(jsonNum(s))
			n[j] = v
		}
		if all {
			out.Usage = &n
			break
		}
	}
	for _, x := range last {
		if s, ok := x.(string); ok && strings.HasPrefix(s, "models/") {
			out.Model = s[7:]
			break
		}
	}
	out.Complete = out.Usage != nil
	return out
}

func jsonNum(s string) any { v, _ := ParseJSON([]byte(s)); return v }

func openaiUsage(u *[3]int64) *Obj {
	if u == nil {
		return nil
	}
	prompt := u[0] + u[2]
	return NewObj().Set("prompt_tokens", prompt).Set("completion_tokens", u[1]).Set("total_tokens", prompt+u[1]).
		Set("prompt_tokens_details", NewObj().Set("cached_tokens", u[2]))
}

// ---------------- document (anti-truncation reply file) ----------------
var reDocName = regexp.MustCompile(`^__bridge_reply_[a-f0-9]{24}\.txt$`)
var reSha = regexp.MustCompile(`^[a-f0-9]{64}$`)
var reAck = regexp.MustCompile(`(?i)^\s*\**\s*done\s*\**\s*[.!。]?\s*$`)

func documentName() string { return "__bridge_reply_" + randHexN(12) + ".txt" }

func docInstruction(name string) string {
	return "Output delivery: write the complete answer into the UTF-8 project file " + name + " using the Build file-writing tool. " +
		"The file body is the API reply: preserve the requested text, Markdown, JSON, whitespace and any tool-call protocol exactly. " +
		"Do not summarize, shorten, or add a receipt. Do not run commands. After writing the file, reply in chat with only: DONE"
}

func docFindHash(raw, name string) string {
	if !reDocName.MatchString(name) {
		return ""
	}
	J, err := ParseJSON([]byte(raw))
	if err != nil {
		return ""
	}
	hit := ""
	var walk func(v any, d int)
	walk = func(v any, d int) {
		a, ok := v.([]any)
		if d > 14 || !ok {
			return
		}
		if len(a) >= 2 && a[0] == name {
			if s, ok := a[1].(string); ok && reSha.MatchString(s) {
				hit = s
			}
		}
		for _, x := range a {
			walk(x, d+1)
		}
	}
	walk(J, 0)
	return hit
}

func docIsAck(t string) bool { return strings.TrimSpace(t) == "" || reAck.MatchString(t) }