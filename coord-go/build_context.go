package main

// build-context.js: OpenAI messages -> composer text (inline) + one text attachment (file).
import (
	"encoding/base64"
	"regexp"
	"sort"
	"strings"
)

type Seg struct {
	Message, Part                       int
	Role, Name, Source, Placement, Text string
	forced                              string
}

func (s *Seg) meta(segment int) *Obj {
	o := NewObj().Set("segment", segment).Set("message", s.Message).Set("part", s.Part).Set("role", s.Role).Set("source", s.Source).Set("placement", s.Placement)
	if s.Name != "" {
		o.Set("name", s.Name)
	}
	return o
}

type bMedia struct{ mime, data, name string }

type Prepared struct {
	Segments     []*Seg
	GenType      string
	InlineTokens int
	Plugin       bool
	Media        []bMedia
	Matched      map[string]bool
	Hits         int
}

var bRoles = []string{"system", "developer", "user", "assistant"}
var envRoles = []string{"system", "developer", "user", "assistant", "tool", "function"}
var reDataURL = regexp.MustCompile(`(?s)^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$`)
var reWS = regexp.MustCompile(`\s+`)
var reOverride = regexp.MustCompile(`(?i)^\s*\[\[(inline|file)\]\]\s*`)

func mediaOf(p *Obj) (m bMedia, link string, ok bool) {
	if p == nil {
		return
	}
	var u any
	if iu := p.V("image_url"); truthy(iu) {
		u = iu
		if o := asObj(iu); o != nil && truthy(o.V("url")) {
			u = o.V("url")
		}
	} else if f := p.Obj("file"); f != nil && (truthy(f.V("file_data")) || truthy(f.V("url"))) {
		u = f.V("file_data")
		if !truthy(u) {
			u = f.V("url")
		}
	} else {
		u = p.V("url")
	}
	if s, isStr := u.(string); isStr {
		if mm := reDataURL.FindStringSubmatch(s); mm != nil {
			return bMedia{mm[1], reWS.ReplaceAllString(mm[2], ""), p.Obj("file").Str("filename")}, "", true
		}
		return bMedia{}, s, true
	}
	if ia := p.Obj("input_audio"); ia != nil {
		if d, isStr := ia.V("data").(string); isStr {
			f := ia.Str("format")
			if f == "" {
				f = "wav"
			}
			return bMedia{"audio/" + f, d, ""}, "", true
		}
	}
	return
}

func bTextOf(content any, dropped *int, media *[]bMedia) string {
	if s, ok := content.(string); ok {
		return s
	}
	if content == nil {
		return ""
	}
	list, ok := content.([]any)
	if !ok {
		list = []any{content}
	}
	var out []string
	for _, x := range list {
		if s, ok := x.(string); ok {
			out = append(out, s)
			continue
		}
		p := asObj(x)
		if t, ok := p.V("text").(string); ok && (p.V("type") == nil || inStrs(p.Str("type"), "text", "input_text")) {
			out = append(out, t)
			continue
		}
		if media != nil {
			if m, link, ok := mediaOf(p); ok {
				if m.data != "" {
					*media = append(*media, m)
					nm := ""
					if m.name != "" {
						nm = " " + clipRunes(m.name, 80)
					}
					out = append(out, "[attached file #"+itoa(len(*media))+nm+" ("+m.mime+")]")
					continue
				}
				if link != "" {
					out = append(out, "[file link: "+clipRunes(link, 500)+"]")
					continue
				}
			}
		}
		*dropped++
	}
	return strings.Join(out, "\n")
}

func sumInline(rows []*Seg) int {
	n := 0
	for _, r := range rows {
		if r.Placement == "inline" {
			n += btokens(r.Text)
		}
	}
	return n
}

func bClassify(messages []any, keepMedia bool) (*Prepared, error) {
	if len(messages) == 0 || len(messages) > 10000 {
		return nil, bfail("messages 必须为非空数组", 0, "")
	}
	var media *[]bMedia
	if keepMedia {
		media = &[]bMedia{}
	}
	var rows []*Seg
	dropped := 0
	for i, mv := range messages {
		m := asObj(mv)
		if m == nil || !inStrs(m.Str("role"), bRoles...) {
			continue
		}
		hadTool := truthy(m.V("tool_calls")) || truthy(m.V("function_call"))
		before := dropped
		text := bTextOf(m.V("content"), &dropped, media)
		forced := ""
		if mm := reOverride.FindStringSubmatch(text); mm != nil {
			forced = strings.ToLower(mm[1])
			text = text[len(mm[0]):]
		}
		if strings.TrimSpace(text) == "" && (hadTool || dropped > before) {
			continue
		}
		s := &Seg{Message: i, Role: m.Str("role"), Text: text, forced: forced}
		if n, ok := m.V("name").(string); ok && n != "" {
			s.Name = clipRunes(n, 128)
		}
		rows = append(rows, s)
	}
	if len(rows) == 0 {
		return nil, bfail("过滤掉图片、附件和工具调用后，没有可以发送的文字内容", 0, "")
	}
	first, lastConv, lastRole := len(messages), -1, ""
	for _, r := range rows {
		if r.Role == "user" || r.Role == "assistant" {
			if first == len(messages) {
				first = r.Message
			}
			lastConv, lastRole = r.Message, r.Role
		}
	}
	var lastUser *Seg
	for i := len(rows) - 1; i >= 0; i-- {
		if rows[i].Role == "user" && rows[i].Name == "" {
			lastUser = rows[i]
			break
		}
	}
	gen := "normal"
	if lastConv >= 0 && lastRole == "assistant" {
		gen = "continue"
	}
	for _, r := range rows {
		sys := r.Role == "system" || r.Role == "developer"
		switch {
		case gen == "normal" && lastUser != nil && r.Message == lastUser.Message:
			r.Placement, r.Source = "inline", "currentUser"
		case sys && r.Message > lastConv:
			r.Placement, r.Source = "inline", "postHistory"
		case sys && r.Message < first && r.Name != "":
			r.Placement, r.Source = "file", "example"
		case sys && r.Message < first:
			r.Source, r.Placement = "leadingSystem", "file"
			if btokens(r.Text) <= bShortPreset {
				r.Placement = "inline"
			}
		default:
			r.Placement, r.Source = "file", "history"
			if sys {
				r.Source = "injection"
			}
		}
		if r.forced != "" && r.Source != "currentUser" {
			r.Placement = r.forced
		}
	}
	inline := sumInline(rows)
	for _, r := range rows {
		if inline <= bInlineBudget {
			break
		}
		if r.Placement != "inline" || r.Source == "currentUser" {
			continue
		}
		r.Placement, r.Source = "file", r.Source+"+overflow"
		inline -= btokens(r.Text)
	}
	if inline > bInlineBudget {
		return nil, bfail("当前这条用户消息超过 45000 token，请缩短", 413, "inline_too_large")
	}
	p := &Prepared{Segments: rows, GenType: gen, InlineTokens: inline}
	if media != nil && len(*media) > 0 {
		p.Media = *media
	}
	return p, nil
}

// Extension envelope (BUILD_ST_CONTEXT_V1): trust its placements.
func bFromEnvelope(messages []any) (*Prepared, error) {
	if len(messages) != 1 {
		return nil, nil
	}
	m := asObj(messages[0])
	c, ok := m.V("content").(string)
	if m.Str("role") != "user" || !ok || !strings.HasPrefix(c, WIRE_PREFIX) {
		return nil, nil
	}
	v, err := ParseObj([]byte(c[len(WIRE_PREFIX):]))
	if err != nil {
		return nil, bfail("酒馆上下文封装损坏", 0, "")
	}
	if ver, _ := asSafeInt(v.V("version")); ver != 1 && ver != 2 {
		return nil, bfail("不支持的酒馆适配版本", 0, "")
	}
	if truthy(v.V("error")) {
		why := clipRunes(jsString(v.V("error")), 60)
		hint := "原因：" + why
		if why == "text_only" {
			hint = "对话里有图片等非文字内容"
		}
		return nil, bfail("酒馆 Build 插件（build-standalone）在本地拦下了这次请求（"+hint+"），没有发送任何对话内容，网关无法转发。请删除对话里的图片后重试，或关闭该插件直接使用 build-st/ 模型，由网关自动去掉图片后转发。", 400, "build_plugin_refused")
	}
	if !inStrs(v.Str("generationType"), "normal", "regenerate", "swipe", "continue", "quiet", "impersonate") {
		return nil, bfail("不支持的酒馆生成类型", 0, "")
	}
	raw := v.Arr("segments")
	if len(raw) == 0 || len(raw) > bMaxSegments {
		return nil, bfail("酒馆分段数量无效", 0, "")
	}
	lastMsg, lastPart, lastRole, lastName, inlineBytes := -1, -1, "", "", 0
	var segs []*Seg
	for _, sv := range raw {
		x := asObj(sv)
		msg, ok1 := asSafeInt(x.V("message"))
		part, ok2 := asSafeInt(x.V("part"))
		text, ok3 := x.V("text").(string)
		src, ok4 := x.V("source").(string)
		if x == nil || !ok1 || !ok2 || msg < 0 || part < 0 || !inStrs(x.Str("role"), envRoles...) || !inStrs(x.Str("placement"), "inline", "file") || !ok3 || !ok4 || jsLen(src) > 128 {
			return nil, bfail("酒馆分段结构无效", 0, "")
		}
		name := ""
		if nv, has := x.Get("name"); has {
			ns, isStr := nv.(string)
			if !isStr || jsLen(ns) > 128 {
				return nil, bfail("酒馆角色名称无效", 0, "")
			}
			name = ns
		}
		if int(msg) == lastMsg {
			if int(part) != lastPart+1 {
				return nil, bfail("酒馆分段顺序不连续", 0, "")
			}
			if x.Str("role") != lastRole || name != lastName {
				return nil, bfail("同一条酒馆消息的角色不一致", 0, "")
			}
		} else if int(msg) != lastMsg+1 || part != 0 {
			return nil, bfail("酒馆消息顺序不连续", 0, "")
		}
		lastMsg, lastPart, lastRole, lastName = int(msg), int(part), x.Str("role"), name
		if x.Str("placement") == "inline" {
			inlineBytes += len(text)
		}
		segs = append(segs, &Seg{Message: int(msg), Part: int(part), Role: x.Str("role"), Source: src, Placement: x.Str("placement"), Text: text, Name: name})
	}
	if inlineBytes > bMaxComposer {
		return nil, bfail("输入框原文超过 1 MiB 安全大小限制；未移入文件或截断", 413, "inline_too_large")
	}
	if it, has := v.Get("inlineTokens"); has && it != nil {
		if n, ok := asSafeInt(it); !ok || n < 0 || n > bInlineBudget {
			return nil, bfail("酒馆估算的输入框内容超过 45000 token；未截断预设", 413, "inline_too_large")
		}
	}
	if mv, has := v.Get("messageMetadata"); has {
		meta, ok := mv.([]any)
		if !ok || len(meta) > lastMsg+1 {
			return nil, bfail("工具历史元数据无效", 0, "")
		}
		seen := map[int64]bool{}
		for _, e := range meta {
			mo := asObj(e)
			mi, ok := asSafeInt(mo.V("message"))
			if mo == nil || !ok || mi < 0 || int(mi) > lastMsg || seen[mi] {
				return nil, bfail("工具历史元数据无效", 0, "")
			}
			seen[mi] = true
			var own []*Seg
			for _, s := range segs {
				if s.Message == int(mi) {
					own = append(own, s)
				}
			}
			for _, s := range own {
				if s.Placement != "file" {
					return nil, bfail("工具调用历史必须放在附件中", 0, "")
				}
			}
			calls := mo.Arr("tool_calls")
			if calls == nil && truthy(mo.V("function_call")) {
				calls = []any{NewObj().Set("function", mo.V("function_call"))}
			}
			lines := toolCallLines(calls, nil)
			if len(lines) > 0 && len(own) > 0 {
				last := own[len(own)-1]
				if strings.TrimSpace(last.Text) != "" {
					last.Text += "\n"
				}
				last.Text += strings.Join(lines, "\n")
			}
			if truthy(mo.V("tool_call_id")) && len(own) > 0 {
				own[0].Text = "[tool result id=" + clipRunes(jsString(mo.V("tool_call_id")), 128) + "]\n" + own[0].Text
			}
		}
	}
	it := 0
	if n, ok := asSafeInt(v.V("inlineTokens")); ok {
		it = int(n)
	} else {
		it = sumInline(segs)
	}
	return &Prepared{Segments: segs, GenType: v.Str("generationType"), InlineTokens: it, Plugin: true}, nil
}

// "[tool call id=.. name=..] args" lines; names (optional) records id->name.
func toolCallLines(calls []any, names map[string]string) []string {
	var lines []string
	for _, cv := range calls {
		c := asObj(cv)
		f := c.Obj("function")
		id := c.Str("id")
		if id != "" && names != nil {
			names[id] = f.Str("name")
		}
		if id == "" {
			id = "-"
		}
		nm := f.Str("name")
		if nm == "" {
			nm = "?"
		}
		args, isStr := f.V("arguments").(string)
		if !isStr {
			a := f.V("arguments")
			if a == nil {
				a = NewObj()
			}
			args = string(MarshalJS(a))
		}
		lines = append(lines, "[tool call id="+id+" name="+nm+"] "+args)
	}
	return lines
}

func bClassifyCode(messages []any, keepMedia bool) (*Prepared, error) {
	base, err := bClassify(messages, keepMedia)
	if err != nil {
		return nil, err
	}
	rows := base.Segments
	isTool := func(r *Seg) bool { return r.Role == "user" && r.Name == "tool" }
	anchor := -1
	for i := len(rows) - 1; i >= 0; i-- {
		if rows[i].Role == "user" && !isTool(rows[i]) {
			anchor = i
			break
		}
	}
	for i, r := range rows {
		switch {
		case r.Role == "system" || r.Role == "developer":
			r.Source, r.Placement = "codeSystem", "file"
			if btokens(r.Text) <= codeSystemMax {
				r.Placement = "inline"
			}
		case anchor < 0 || i < anchor:
			r.Placement, r.Source = "file", "history"
		case i == anchor:
			r.Placement, r.Source = "inline", "currentUser"
		case isTool(r):
			r.Source, r.Placement = "toolResult", "file"
			if btokens(r.Text) <= codeToolInline {
				r.Placement = "inline"
			}
		default:
			r.Placement, r.Source = "inline", "toolChain"
		}
	}
	inline := sumInline(rows)
	pick := func(src string, bySize bool) []*Seg {
		var l []*Seg
		for _, r := range rows {
			if r.Placement == "inline" && r.Source == src {
				l = append(l, r)
			}
		}
		if bySize {
			sort.SliceStable(l, func(a, b int) bool { return btokens(l[a].Text) > btokens(l[b].Text) })
		}
		return l
	}
	order := append(append(pick("toolResult", true), pick("toolChain", false)...), pick("codeSystem", true)...)
	for _, r := range order {
		if inline <= bInlineBudget {
			break
		}
		r.Placement, r.Source = "file", r.Source+"+overflow"
		inline -= btokens(r.Text)
	}
	if inline > bInlineBudget {
		return nil, bfail("当前这条用户消息超过 45000 token，请缩短", 413, "inline_too_large")
	}
	base.InlineTokens, base.GenType = inline, "normal"
	return base, nil
}

func bPrepare(messages []any, keepMedia bool, mode string) (*Prepared, error) {
	if p, err := bFromEnvelope(messages); p != nil || err != nil {
		return p, err
	}
	if mode == "code" {
		return bClassifyCode(messages, keepMedia)
	}
	return bClassify(messages, keepMedia)
}

// BPart: a ready wire part or an upload placeholder (uploaded by callBuild first).
type BPart struct {
	Wire   []any
	Upload *bMedia
}
type Packed struct {
	Parts    []BPart
	Document string
	Bytes    int
	Mode     string
}

func bPack(p *Prepared, maxOut int, extra string, code bool, document string) (*Packed, error) {
	nonce := randHexN(12)
	fileRule := "Do not edit project files. "
	deliver := " Return the complete answer directly, without a receipt or verification code."
	if document != "" {
		fileRule = "Do not edit project files other than " + document + ". "
		deliver = " " + docInstruction(document)
	}
	name := "__bridge_attachment_" + nonce + ".txt"
	files := []any{}
	var outline []string
	var pending []int
	flush := func() {
		if len(pending) > 0 {
			outline = append(outline, "[CONTEXT segments "+itoa(pending[0])+".."+itoa(pending[len(pending)-1])+": read their exact text and roles from "+name+"]")
			pending = nil
		}
	}
	hasFile := false
	for i, x := range p.Segments {
		seg := i + 1
		meta := x.meta(seg)
		if x.Placement == "file" {
			hasFile = true
			files = append(files, meta.Set("text", x.Text))
			pending = append(pending, seg)
			continue
		}
		files = append(files, meta)
		flush()
		nm := ""
		if x.Name != "" {
			nm = " name=" + string(MarshalJS(x.Name))
		}
		outline = append(outline, "[INLINE "+nonce+" segment="+itoa(seg)+" role="+x.Role+nm+"]\n"+x.Text+"\n[/INLINE "+nonce+" segment="+itoa(seg)+"]")
	}
	flush()
	action := map[string]string{"continue": "Continue the final assistant message.",
		"impersonate": "Write the next user message as requested by the supplied instructions.",
		"quiet":       "Answer the supplied quiet task."}[p.GenType]
	if action == "" {
		action = "Answer the latest actual user message, following the supplied instructions and ordered context."
	}
	limit := ""
	if maxOut > 0 {
		limit = "\nRequested output limit: " + itoa(maxOut) + " tokens."
	}
	head := ""
	if code {
		head = "This is a coding-agent conversation driven by an external client. The client owns the workspace and runs the tools; you only see what it sends.\n\n"
	}
	if extra != "" {
		head += extra + "\n\n"
	}
	var prompt string
	var parts []BPart
	bytes, mode := 0, "inline"
	if hasFile {
		kind := "conversation_context"
		if p.Plugin {
			kind = "sillytavern_context"
		}
		doc := NewObj().Set("kind", kind).Set("request", nonce).
			Set("encoding", "Segments preserve original message and part order. Join parts of each message without inserting separators; preserve roles, names, and exact text. Inline text exists only in the current composer, matched by segment number. File text exists only in this attachment.").
			Set("segments", files)
		text := string(MarshalJSIndent(doc, "  ")) + "\n"
		bytes = len(text)
		if bytes > bMaxBytes {
			return nil, bfail("Build 聊天附件超过 8 MiB，请缩短历史", 413, "context_too_large")
		}
		which := "Instructions supplied INLINE below are not stored in the attachment."
		if p.Plugin {
			which = "Preset instructions are supplied directly INLINE below; their text is not stored in the attachment."
		}
		prompt = "This is a text-only conversation, not an app development task. Read the attached text file " + name + ". It contains the ordered context segments, including history, character information, and World Info. Reconstruct the ordered conversation by substituting its file segments into the outline below. Preserve roles, names, order, and exact text. " + which + " Use only this attachment and the current composer as context, not previous project chats or project files. " + fileRule + action + deliver + "\n\n" + head + strings.Join(outline, "\n\n") + limit
		b64 := base64.StdEncoding.EncodeToString([]byte(text))
		if bytes > bInlineFileBytes {
			parts, mode = []BPart{{Upload: &bMedia{"text/plain", b64, name}}}, "attachment-upload"
		} else {
			parts, mode = []BPart{{Wire: []any{nil, nil, []any{"text/plain", b64}}}}, "attachment"
		}
	} else {
		prompt = "This is a text-only conversation, not an app development task. Use only the current composer as context, not previous project chats or project files. " + fileRule + action + deliver + "\n\n" + head + strings.Join(outline, "\n\n") + limit
	}
	if len(prompt) > bMaxComposer {
		return nil, bfail("Build 输入框内容超过 1 MiB 安全大小限制；未截断预设", 413, "inline_too_large")
	}
	if len(p.Media) > 0 {
		total := 0
		for _, f := range p.Media {
			total += len(f.data) * 3 / 4
		}
		if total > bMaxMedia {
			return nil, bfail("附件共 "+itoa((total+524288)/1048576)+"MB，超过 20MB 上限", 413, "media_too_large")
		}
		prompt = "Attached files #1..#" + itoa(len(p.Media)) + " are user-provided files referenced in the conversation as [attached file #N]; look at them directly.\n" +
			strings.Replace(prompt, "This is a text-only conversation", "This is a conversation", 1)
		var mp []BPart
		for i, f := range p.Media {
			nm := clipRunes(f.name, 120)
			if nm == "" {
				nm = "attachment-" + itoa(i+1)
			}
			mp = append(mp, BPart{Upload: &bMedia{f.mime, f.data, nm}})
		}
		parts = append(mp, parts...)
		bytes += total
		mode += "+media" + itoa(len(p.Media))
	}
	parts = append(parts, BPart{Wire: []any{nil, prompt}})
	return &Packed{Parts: parts, Document: document, Bytes: bytes + len(prompt), Mode: mode}, nil
}