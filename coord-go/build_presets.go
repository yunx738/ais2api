package main

// build-presets.js: uploaded SillyTavern presets -> server-side context splitting for the Build channel.
// Positions are byte offsets (the JS version uses UTF-16 offsets; gap limits are applied in characters).
import (
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"
)

var stBackground = map[string]bool{"worldInfoBefore": true, "worldInfoAfter": true, "charDescription": true, "charPersonality": true, "scenario": true,
	"personaDescription": true, "dialogueExamples": true, "chatHistory": true, "summary": true, "authorsNote": true, "vectorsMemory": true,
	"vectorsDataBank": true, "smartContext": true}

const (
	stMinLiteral = 12
	stMaxGap     = 300000
	stGapFile    = 1500
	stMaxPresets = 20
	stMaxPrompts = 1000
	stMaxDepth   = 8
)

var reMacroTag = regexp.MustCompile(`(?i)^<(?:USER|BOT|CHAR|CHARIFNOTGROUP|GROUP)>`)
var reDollar = regexp.MustCompile(`^\$[0-9A-Z]`)

func stNorm(t string) string {
	t = strings.TrimPrefix(t, "\uFEFF")
	t = strings.ReplaceAll(t, "\r\n", "\n")
	return strings.ReplaceAll(t, "\r", "\n")
}

func chunksOf(text string) []string {
	text = stNorm(text)
	var out []string
	var buf strings.Builder
	flush := func() {
		if t := strings.TrimSpace(buf.String()); t != "" {
			out = append(out, t)
		}
		buf.Reset()
	}
	i := 0
	for i < len(text) {
		if strings.HasPrefix(text[i:], "{{") {
			d, j := 0, i
			for j < len(text) {
				if strings.HasPrefix(text[j:], "{{") {
					d++
					j += 2
				} else if strings.HasPrefix(text[j:], "}}") {
					d--
					j += 2
					if d == 0 {
						break
					}
				} else {
					j++
				}
			}
			flush()
			i = j
			continue
		}
		if strings.HasPrefix(text[i:], "<%") {
			k := strings.Index(text[i+2:], "%>")
			flush()
			if k < 0 {
				i = len(text)
			} else {
				i = i + 2 + k + 2
			}
			continue
		}
		if text[i] == '<' {
			end := i + 20
			if end > len(text) {
				end = len(text)
			}
			if m := reMacroTag.FindString(text[i:end]); m != "" {
				flush()
				i += len(m)
				continue
			}
		}
		if text[i] == '$' && i+2 <= len(text) && reDollar.MatchString(text[i:]) {
			if i+2 == len(text) || !isAlnum(text[i+2]) {
				flush()
				i += 2
				continue
			}
		}
		_, size := utf8.DecodeRuneInString(text[i:])
		buf.WriteString(text[i : i+size])
		i += size
	}
	flush()
	return out
}
func isAlnum(c byte) bool { return c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

func stCollect(node any, depth int, out *[]*Obj) {
	if depth > stMaxDepth || len(*out) >= stMaxPrompts*4 {
		return
	}
	if a, ok := node.([]any); ok {
		for _, x := range a {
			if o := asObj(x); o != nil {
				if _, ok := o.V("content").(string); ok {
					*out = append(*out, o)
					continue
				}
			}
			stCollect(x, depth+1, out)
		}
		return
	}
	if o := asObj(node); o != nil {
		for _, k := range o.Keys() {
			stCollect(o.V(k), depth+1, out)
		}
	}
}

func parsePreset(preset any) ([]any, error) {
	if preset == nil || (asObj(preset) == nil && asArr(preset) == nil) {
		return nil, herr(400, "文件内容不是预设（需要 JSON 对象或数组）")
	}
	var items []*Obj
	stCollect(preset, 0, &items)
	if len(items) == 0 {
		return nil, herr(400, "文件里没有找到提示词条目（带 content 的条目）")
	}
	out := []any{}
	seen := map[string]bool{}
	for _, p := range items {
		if len(out) >= stMaxPrompts {
			break
		}
		if p.V("marker") == true {
			continue
		}
		ident := jsStr(p.V("identifier"))
		if ident == "" {
			ident = jsStr(p.V("id"))
		}
		ident = clipRunes(ident, 100)
		if stBackground[ident] {
			continue
		}
		chunks := chunksOf(p.Str("content"))
		if jsLen(strings.Join(chunks, "")) < stMinLiteral {
			continue
		}
		key := strings.Join(chunks, "\x00")
		if seen[key] {
			continue
		}
		seen[key] = true
		label := jsStr(p.V("name"))
		if label == "" {
			label = jsStr(p.V("identifier"))
		}
		if label == "" {
			longest := ""
			for _, c := range chunks {
				if jsLen(c) > jsLen(longest) {
					longest = c
				}
			}
			label = clipRunes(reWS.ReplaceAllString(longest, " "), 18) + "…"
		}
		id := ident
		if id == "" {
			id = "p"
		}
		ca := make([]any, len(chunks))
		for i, c := range chunks {
			ca[i] = c
		}
		out = append(out, NewObj().Set("id", id+"#"+itoa(len(out))).Set("name", clipRunes(label, 128)).Set("chunks", ca))
	}
	if len(out) == 0 {
		return nil, herr(400, "预设里没有可识别的条目（条目需有正文，且不能只有宏）")
	}
	return out, nil
}

type stPrompt struct {
	id     string
	chunks []string
	total  int
}
type stSpan struct {
	start, end int
	source     string
	pos        [][2]int
}

func runesBetween(text string, a, b int) int {
	if b <= a {
		return 0
	}
	return utf8.RuneCountInString(text[a:b])
}

func findOne(text string, chunks []string, from int) [][2]int {
	k := 0
	for i := 1; i < len(chunks); i++ {
		if len(chunks[i]) > len(chunks[k]) {
			k = i
		}
	}
	off := strings.Index(text[from:], chunks[k])
	for off >= 0 {
		pos := from + off
		hit := make([][2]int, len(chunks))
		hit[k] = [2]int{pos, pos + len(chunks[k])}
		ok := true
		for i := k - 1; i >= 0 && ok; i-- {
			lim := hit[i+1][0] - len(chunks[i])
			at := -1
			if lim >= from {
				at = strings.LastIndex(text[:lim+len(chunks[i])], chunks[i])
			}
			if at < from || runesBetween(text, at+len(chunks[i]), hit[i+1][0]) > stMaxGap {
				ok = false
			} else {
				hit[i] = [2]int{at, at + len(chunks[i])}
			}
		}
		for i := k + 1; i < len(chunks) && ok; i++ {
			o := strings.Index(text[hit[i-1][1]:], chunks[i])
			if o < 0 || runesBetween(text, hit[i-1][1], hit[i-1][1]+o) > stMaxGap {
				ok = false
			} else {
				at := hit[i-1][1] + o
				hit[i] = [2]int{at, at + len(chunks[i])}
			}
		}
		if ok {
			return hit
		}
		n := strings.Index(text[pos+1:], chunks[k])
		if n < 0 {
			break
		}
		off = pos + 1 + n - from
	}
	return nil
}

func stSpans(text string, prompts []stPrompt) []stSpan {
	var found []stSpan
	free := func(a, b int) bool {
		for _, s := range found {
			if a < s.end && b > s.start {
				return false
			}
		}
		return true
	}
	for _, p := range prompts {
		from := 0
		for from < len(text) {
			hit := findOne(text, p.chunks, from)
			if hit == nil {
				break
			}
			st, en := hit[0][0], hit[len(hit)-1][1]
			if free(st, en) {
				found = append(found, stSpan{st, en, p.id, hit})
			}
			from = en
		}
	}
	sort.SliceStable(found, func(a, b int) bool { return found[a].start < found[b].start })
	return found
}

func stTextOf(c any) (string, bool) {
	if s, ok := c.(string); ok {
		return s, true
	}
	a, ok := c.([]any)
	if !ok {
		return "", false
	}
	var ts []string
	for _, p := range a {
		po := asObj(p)
		t, ok := po.V("text").(string)
		if po.Str("type") != "text" || !ok {
			return "", false
		}
		ts = append(ts, t)
	}
	return strings.Join(ts, "\n"), true
}

func stSegment(messages []any, prompts []stPrompt) *Prepared {
	if len(messages) == 0 || len(prompts) == 0 {
		return nil
	}
	type row struct{ role, name, text string }
	var rows []row
	for _, mv := range messages {
		m := asObj(mv)
		if m == nil || !inStrs(m.Str("role"), bRoles...) || truthy(m.V("tool_calls")) || truthy(m.V("function_call")) {
			return nil
		}
		t, ok := stTextOf(m.V("content"))
		if !ok {
			return nil
		}
		nm, _ := m.V("name").(string)
		rows = append(rows, row{m.Str("role"), clipRunes(nm, 128), stNorm(t)})
	}
	if len(rows) == 1 && strings.HasPrefix(rows[0].text, WIRE_PREFIX) {
		return nil
	}
	ordered := append([]stPrompt(nil), prompts...)
	sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].total > ordered[b].total })
	last := -1
	for i, r := range rows {
		if r.role == "user" || r.role == "assistant" {
			last = i
		}
	}
	gen := "normal"
	if last >= 0 && rows[last].role == "assistant" {
		gen = "continue"
	}
	current := -1
	if gen == "normal" {
		for i := len(rows) - 1; i >= 0; i-- {
			if rows[i].role == "user" && rows[i].name == "" {
				current = i
				break
			}
		}
	}
	var segs []*Seg
	matched := map[string]bool{}
	hits := 0
	for i, r := range rows {
		list := stSpans(r.text, ordered)
		restP, restS := "file", "context"
		if i == current {
			restP, restS = "inline", "currentUser"
		}
		part, at := 0, 0
		had := false
		push := func(text, placement, source string) {
			if strings.TrimSpace(text) != "" {
				segs = append(segs, &Seg{Message: i, Role: r.role, Name: r.name, Part: part, Source: source, Placement: placement, Text: text})
				part++
				had = true
			}
		}
		for _, s := range list {
			push(r.text[at:s.start], restP, restS)
			hits++
			matched[s.source] = true
			piece := s.start
			for k := 1; k < len(s.pos); k++ {
				gs, ge := s.pos[k-1][1], s.pos[k][0]
				if runesBetween(r.text, gs, ge) > stGapFile {
					push(r.text[piece:gs], "inline", s.source)
					push(r.text[gs:ge], restP, restS)
					piece = ge
				}
			}
			push(r.text[piece:s.end], "inline", s.source)
			at = s.end
		}
		push(r.text[at:], restP, restS)
		if !had {
			segs = append(segs, &Seg{Message: i, Role: r.role, Name: r.name, Part: 0, Source: restS, Placement: restP, Text: r.text})
		}
	}
	if hits == 0 {
		return nil
	}
	inline := sumInline(segs)
	for _, x := range segs {
		if inline <= bInlineBudget {
			break
		}
		if x.Placement != "inline" || x.Source == "currentUser" {
			continue
		}
		x.Placement, x.Source = "file", x.Source+"+overflow"
		inline -= btokens(x.Text)
	}
	return &Prepared{Segments: segs, GenType: gen, InlineTokens: inline, Hits: hits, Matched: matched}
}

func stEnvelope(p *Prepared) string {
	segs := []any{}
	for _, s := range p.Segments {
		o := NewObj().Set("message", s.Message).Set("role", s.Role)
		if s.Name != "" {
			o.Set("name", s.Name)
		}
		o.Set("part", s.Part).Set("source", s.Source).Set("placement", s.Placement).Set("text", s.Text)
		segs = append(segs, o)
	}
	return WIRE_PREFIX + string(MarshalJS(NewObj().Set("version", 1).Set("generationType", p.GenType).Set("segments", segs).Set("inlineTokens", p.InlineTokens)))
}

type PresetStore struct {
	mu    sync.Mutex
	file  string
	cache *Obj
}

func (s *PresetStore) read() *Obj {
	if s.cache != nil {
		return s.cache
	}
	s.cache = NewObj().Set("presets", []any{})
	if raw, err := readJSONFile(s.file); err == nil {
		if o := asObj(raw); o != nil && o.Arr("presets") != nil {
			s.cache = o
		}
	}
	return s.cache
}
func (s *PresetStore) save() error { return writeSimple(s.file, MarshalJS(s.cache), 0644) }

func (s *PresetStore) List() []any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []any{}
	for _, pv := range s.read().Arr("presets") {
		p := asObj(pv)
		names := []any{}
		for _, x := range p.Arr("prompts") {
			names = append(names, asObj(x).V("name"))
		}
		req, _ := asNum(p.V("requests"))
		lh, _ := asNum(p.V("lastHits"))
		var lastAt any
		if truthy(p.V("lastHitAt")) {
			lastAt = p.V("lastHitAt")
		}
		out = append(out, NewObj().Set("id", p.V("id")).Set("name", p.V("name")).Set("uploadedAt", p.V("uploadedAt")).
			Set("enabled", p.V("enabled") != false).Set("prompts", names).Set("requests", req).Set("lastHitAt", lastAt).Set("lastHits", lh))
	}
	return out
}
func (s *PresetStore) Add(name any, preset any) (*Obj, error) {
	prompts, err := parsePreset(preset)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.read()
	if len(d.Arr("presets")) >= stMaxPresets {
		return nil, herr(400, "最多保存 20 个预设，请先删除不用的")
	}
	nm := regexp.MustCompile(`(?i)\.json$`).ReplaceAllString(jsStr(name), "")
	nm = clipRunes(nm, 80)
	if nm == "" {
		nm = "预设"
	}
	item := NewObj().Set("id", randHexN(6)).Set("name", nm).Set("uploadedAt", nowMs()).Set("enabled", true).Set("prompts", prompts)
	d.Set("presets", append(d.Arr("presets"), item))
	if err := s.save(); err != nil {
		return nil, err
	}
	return NewObj().Set("id", item.V("id")).Set("name", nm).Set("prompts", len(prompts)), nil
}
func (s *PresetStore) Remove(id string) (*Obj, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.read()
	var keep []any
	for _, p := range d.Arr("presets") {
		if asObj(p).Str("id") != id {
			keep = append(keep, p)
		}
	}
	if len(keep) == len(d.Arr("presets")) {
		return nil, herr(404, "预设不存在")
	}
	if keep == nil {
		keep = []any{}
	}
	d.Set("presets", keep)
	s.save()
	return NewObj().Set("ok", true), nil
}
func (s *PresetStore) SetEnabled(id string, on any) (*Obj, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.read().Arr("presets") {
		if po := asObj(p); po.Str("id") == id {
			po.Set("enabled", truthy(on))
			s.save()
			return NewObj().Set("ok", true), nil
		}
	}
	return nil, herr(404, "预设不存在")
}

// Apply: messages -> envelope content, or "" when no preset text was found.
func (s *PresetStore) Apply(messages []any) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var active []*Obj
	var prompts []stPrompt
	for _, p := range s.read().Arr("presets") {
		po := asObj(p)
		if po.V("enabled") == false {
			continue
		}
		active = append(active, po)
		for _, x := range po.Arr("prompts") {
			xo := asObj(x)
			var ch []string
			tot := 0
			for _, c := range xo.Arr("chunks") {
				cs, _ := c.(string)
				ch = append(ch, cs)
				tot += jsLen(cs)
			}
			if len(ch) > 0 {
				prompts = append(prompts, stPrompt{xo.Str("id"), ch, tot})
			}
		}
	}
	if len(active) == 0 {
		return ""
	}
	prep := stSegment(messages, prompts)
	if prep == nil {
		return ""
	}
	now := nowMs()
	for _, p := range active {
		n := 0
		for _, x := range p.Arr("prompts") {
			if prep.Matched[asObj(x).Str("id")] {
				n++
			}
		}
		if n > 0 {
			r, _ := asNum(p.V("requests"))
			p.Set("requests", int64(r)+1).Set("lastHitAt", now).Set("lastHits", n)
		}
	}
	s.save()
	return stEnvelope(prep)
}

var _ = os.Stat