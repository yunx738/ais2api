package main

// request-sanitizer.js + sampling-limits.js: repair tool schemas / sampling params before upstream.
import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

type SanitizeError struct{ Msg string }

func (e *SanitizeError) Error() string { return e.Msg }
func sfail(msg string)                 { panic(&SanitizeError{msg}) }

var sTypes = map[string]bool{"STRING": true, "NUMBER": true, "INTEGER": true, "BOOLEAN": true, "ARRAY": true, "OBJECT": true}
var sKeep = map[string]bool{"type": true, "format": true, "description": true, "nullable": true, "enum": true, "items": true, "properties": true, "required": true,
	"anyOf": true, "minItems": true, "maxItems": true, "minimum": true, "maximum": true, "minLength": true, "maxLength": true, "pattern": true, "title": true,
	"default": true, "example": true, "propertyOrdering": true, "minProperties": true, "maxProperties": true}
var reToolName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$`)
var reRef = regexp.MustCompile(`^#/(?:\$defs|definitions)/(.+)$`)

const sMaxDepth = 32

// "undefined" in the JS code = key absent here.
func setOrDel(o *Obj, k string, v any, present bool) {
	if present {
		o.Set(k, v)
	} else {
		o.Del(k)
	}
}

func jsonLower(v any) string { return strings.ToLower(jsString(v)) }

func sSchema(input any, where string, defs *Obj, depth int, seen map[string]bool) *Obj {
	if depth > sMaxDepth {
		sfail(where + ": 参数结构嵌套过深（超过 " + strconv.Itoa(sMaxDepth) + " 层）")
	}
	if input == true || input == nil {
		return NewObj().Set("type", "STRING")
	}
	s := asObj(input)
	if s == nil {
		sfail(where + ": 参数定义必须是对象")
	}
	if ref, ok := s.V("$ref").(string); ok {
		m := reRef.FindStringSubmatch(ref)
		var target *Obj
		if m != nil {
			name := m[1]
			if dec, err := urlDecode(name); err == nil {
				name = dec
			}
			target = defs.Obj(name)
		}
		if target == nil {
			sfail(where + ": 无法解析引用 " + ref)
		}
		if seen[ref] {
			sfail(where + ": 存在循环引用 " + ref + "，无法展开")
		}
		merged := target.Clone()
		for _, k := range s.Keys() {
			if k == "$ref" {
				continue
			}
			merged.Set(k, s.V(k))
		}
		ns := map[string]bool{}
		for k := range seen {
			ns[k] = true
		}
		ns[ref] = true
		return sSchema(merged, where, defs, depth+1, ns)
	}
	if all := s.Arr("allOf"); s.Has("allOf") && all != nil {
		merged := s.Clone()
		merged.Del("allOf")
		for _, part := range all {
			p := asObj(part)
			if p == nil {
				sfail(where + ": allOf 内容无效")
			}
			if truthy(p.V("properties")) {
				props := NewObj()
				if mp := merged.Obj("properties"); mp != nil {
					props = mp.Clone()
				}
				if pp := p.Obj("properties"); pp != nil {
					for _, k := range pp.Keys() {
						props.Set(k, pp.V(k))
					}
				}
				merged.Set("properties", props)
			}
			if req := p.Arr("required"); req != nil {
				cur := append([]any(nil), merged.Arr("required")...)
				merged.Set("required", append(cur, req...))
			}
			for _, k := range p.Keys() {
				if k != "properties" && k != "required" && !merged.Has(k) {
					merged.Set(k, p.V(k))
				}
			}
		}
		s = merged
	}
	out := NewObj()
	typ, hasType := s.Get("type")
	nullable := s.V("nullable") == true
	if arr, ok := typ.([]any); ok {
		var real []any
		for _, t := range arr {
			if jsonLower(t) != "null" {
				real = append(real, t)
			}
		}
		if len(real) != len(arr) {
			nullable = true
		}
		if len(real) > 1 {
			var variants []any
			for _, t := range real {
				x := s.Clone()
				x.Set("type", t)
				x.Del("nullable")
				variants = append(variants, sSchema(x, where, defs, depth+1, seen))
			}
			out.Set("anyOf", variants)
			if nullable {
				out.Set("nullable", true)
			}
			if truthy(s.V("description")) {
				out.Set("description", jsString(s.V("description")))
			}
			return out
		}
		if len(real) == 1 {
			typ, hasType = real[0], true
		} else {
			typ, hasType = nil, false
		}
	}
	if c, ok := s.Get("const"); ok && !s.Has("enum") {
		s = s.Clone()
		s.Set("enum", []any{c})
	}
	variants := s.Arr("anyOf")
	if variants == nil || !s.Has("anyOf") || !truthy(s.V("anyOf")) {
		variants = s.Arr("oneOf")
	}
	if variants != nil {
		var list []any
		for _, v := range variants {
			if vo := asObj(v); vo != nil && jsonLower(vo.V("type")) == "null" {
				continue
			}
			list = append(list, v)
		}
		if len(list) != len(variants) {
			nullable = true
		}
		if len(list) == 0 {
			sfail(where + ": anyOf/oneOf 中没有可用类型")
		}
		if len(list) == 1 && !hasType {
			one := asObj(list[0])
			var x *Obj
			if one != nil {
				x = one.Clone()
			} else {
				x = NewObj()
			}
			d, dok := s.Get("description")
			if !dok || d == nil {
				d, dok = x.Get("description")
			}
			setOrDel(x, "description", d, dok && d != nil)
			setOrDel(x, "nullable", true, nullable)
			if one == nil {
				return sSchema(list[0], where, defs, depth+1, seen)
			}
			return sSchema(x, where, defs, depth+1, seen)
		}
		var outs []any
		for i, v := range list {
			outs = append(outs, sSchema(v, where+".anyOf["+strconv.Itoa(i)+"]", defs, depth+1, seen))
		}
		out.Set("anyOf", outs)
	}
	if !hasType {
		if truthy(s.V("properties")) {
			typ, hasType = "object", true
		} else if truthy(s.V("items")) {
			typ, hasType = "array", true
		} else if !out.Has("anyOf") {
			typ, hasType = "string", true
		}
	}
	if hasType {
		t := strings.ToUpper(jsString(typ))
		if !sTypes[t] {
			sfail(where + ": 不支持的类型 \"" + jsString(typ) + "\"")
		}
		out.Set("type", t)
	}
	for _, k := range s.Keys() {
		v := s.V(k)
		if !sKeep[k] || k == "type" || k == "anyOf" {
			continue
		}
		switch k {
		case "properties":
			po := asObj(v)
			if po == nil {
				sfail(where + ": properties 必须是对象")
			}
			props := NewObj()
			for _, pk := range po.Keys() {
				props.Set(pk, sSchema(po.V(pk), where+"."+pk, defs, depth+1, seen))
			}
			out.Set("properties", props)
		case "items":
			if a, ok := v.([]any); ok {
				var first any
				if len(a) > 0 {
					first = a[0]
				}
				out.Set("items", sSchema(first, where+"[]", defs, depth+1, seen))
			} else {
				out.Set("items", sSchema(v, where+"[]", defs, depth+1, seen))
			}
		case "required":
			if a, ok := v.([]any); ok {
				seenR := map[string]bool{}
				var r []any
				for _, x := range a {
					if xs, ok := x.(string); ok && !seenR[xs] {
						seenR[xs] = true
						r = append(r, xs)
					}
				}
				if r == nil {
					r = []any{}
				}
				out.Set("required", r)
			}
		case "enum":
			a, ok := v.([]any)
			if !ok || len(a) == 0 {
				continue
			}
			var vals []any
			for _, x := range a {
				if x != nil {
					vals = append(vals, x)
				}
			}
			if len(vals) != len(a) {
				nullable = true
			}
			t := out.Str("type")
			if t == "STRING" || !out.Has("type") {
				ss := []any{}
				for _, x := range vals {
					ss = append(ss, jsString(x))
				}
				out.Set("enum", ss)
			} else {
				pre := ""
				if truthy(s.V("description")) {
					pre = jsString(s.V("description")) + " "
				}
				parts := make([]string, len(vals))
				for i, x := range vals {
					parts[i] = jsString(x)
				}
				out.Set("description", pre+"可选值: "+strings.Join(parts, ", "))
			}
		case "description", "title", "format", "pattern":
			if !out.Has(k) {
				out.Set(k, jsString(v))
			}
		case "nullable":
			continue
		default:
			out.Set(k, v)
		}
	}
	if out.Str("type") == "ARRAY" && !out.Has("items") {
		out.Set("items", NewObj().Set("type", "STRING"))
	}
	if req := out.Arr("required"); out.Has("required") {
		props := out.Obj("properties")
		var r []any
		for _, x := range req {
			if props != nil && props.Has(x.(string)) {
				r = append(r, x)
			}
		}
		if len(r) == 0 {
			out.Del("required")
		} else {
			out.Set("required", r)
		}
	}
	if out.Str("type") == "OBJECT" && out.Obj("properties") != nil && out.Obj("properties").Len() == 0 {
		out.Del("properties")
	}
	if nullable {
		out.Set("nullable", true)
	}
	return out
}

func urlDecode(s string) (string, error) {
	// decodeURIComponent
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			n, err := strconv.ParseUint(s[i+1:i+3], 16, 8)
			if err != nil {
				return "", err
			}
			b.WriteByte(byte(n))
			i += 2
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String(), nil
}

func sParams(p any, where string) (*Obj, bool) {
	if p == nil {
		return nil, false
	}
	o := asObj(p)
	if o == nil {
		sfail(where + ": parameters 必须是对象")
	}
	defs := NewObj()
	for _, k := range []string{"definitions", "$defs"} {
		if d := o.Obj(k); d != nil {
			for _, x := range d.Keys() {
				defs.Set(x, d.V(x))
			}
		}
	}
	return sSchema(o, where, defs, 0, map[string]bool{}), true
}

func sCheckName(name any, where string, names map[string]bool) {
	n, ok := name.(string)
	if !ok || !reToolName.MatchString(n) {
		sfail(where + ": 工具名 \"" + clipRunes(jsStr(name), 80) + "\" 不合法（只能用字母、数字、_ . -，以字母或下划线开头，最长 64 位）")
	}
	if names[n] {
		sfail(where + ": 工具名 \"" + n + "\" 重复")
	}
	names[n] = true
}

// sanitizeRequest mutates parsed. Returns changed, notes; SanitizeError for unfixable requests.
func sanitizeRequest(route string, parsed *Obj) (changed bool, notes []string, err error) {
	defer func() {
		if r := recover(); r != nil {
			if se, ok := r.(*SanitizeError); ok {
				err = se
				return
			}
			panic(r)
		}
	}()
	notes = fixSampling(route, parsed)
	changed = len(notes) > 0
	names := map[string]bool{}
	fix := func(holder *Obj, key, where string) {
		v, ok := holder.Get(key)
		if !ok {
			return
		}
		before := string(MarshalJS(v))
		after, ok := sParams(v, where)
		if !ok {
			return
		}
		if string(MarshalJS(after)) != before {
			holder.Set(key, after)
			changed = true
		}
	}
	if route == "/v1/chat/completions" {
		if tv, ok := parsed.Get("tools"); ok && tv != nil {
			if _, isArr := tv.([]any); !isArr {
				sfail("tools 必须是数组")
			}
		}
		for i, t := range parsed.Arr("tools") {
			to := asObj(t)
			if to == nil || to.V("type") != "function" {
				continue
			}
			f := to.Obj("function")
			if f == nil {
				sfail("tools[" + strconv.Itoa(i) + "]: 缺少 function 定义")
			}
			sCheckName(f.V("name"), "tools["+strconv.Itoa(i)+"]", names)
			fix(f, "parameters", "工具 "+jsStr(f.V("name")))
			if f.Has("strict") {
				f.Del("strict")
				changed = true
			}
		}
		for i, fv := range parsed.Arr("functions") {
			f := asObj(fv)
			var nm any
			if f != nil {
				nm = f.V("name")
			}
			sCheckName(nm, "functions["+strconv.Itoa(i)+"]", names)
			fix(f, "parameters", "函数 "+jsStr(nm))
		}
		if rfv, ok := parsed.Get("response_format"); ok && rfv != nil {
			rf := asObj(rfv)
			if rf == nil {
				sfail("response_format 必须是对象")
			}
			t := jsStr(rf.V("type"))
			if !inStrs(t, "text", "json_object", "json_schema") || rf.V("type") == nil {
				sfail("response_format.type 不支持: " + clipRunes(jsString(rf.V("type")), 40))
			}
			if t == "json_schema" {
				js := rf.Obj("json_schema")
				if js == nil || !truthy(js.V("schema")) {
					sfail("response_format.json_schema.schema 缺失")
				}
				fix(js, "schema", "response_format")
				if js.Has("strict") {
					js.Del("strict")
					changed = true
				}
			}
		}
	} else {
		gc := parsed.Obj("generationConfig")
		if gc == nil {
			gc = parsed.Obj("generation_config")
		}
		if gc != nil {
			for _, k := range []string{"responseJsonSchema", "response_json_schema"} {
				if v, ok := gc.Get(k); ok {
					if !gc.Has("responseSchema") {
						gc.Set("responseSchema", v)
					}
					gc.Del(k)
					changed = true
				}
			}
			if v, ok := gc.Get("response_schema"); ok && !gc.Has("responseSchema") {
				gc.Set("responseSchema", v)
				gc.Del("response_schema")
				changed = true
			}
			if gc.Has("responseSchema") {
				fix(gc, "responseSchema", "responseSchema")
			}
		}
		if tv, ok := parsed.Get("tools"); ok && tv != nil {
			if _, isArr := tv.([]any); !isArr {
				sfail("tools 必须是数组")
			}
		}
		for _, t := range parsed.Arr("tools") {
			to := asObj(t)
			if to == nil {
				continue
			}
			for _, key := range []string{"functionDeclarations", "function_declarations"} {
				for i, dv := range to.Arr(key) {
					d := asObj(dv)
					if d == nil {
						sfail(key + "[" + strconv.Itoa(i) + "]: 声明无效")
					}
					sCheckName(d.V("name"), key+"["+strconv.Itoa(i)+"]", names)
					if v, ok := d.Get("parametersJsonSchema"); ok && !d.Has("parameters") {
						d.Set("parameters", v)
						d.Del("parametersJsonSchema")
						changed = true
					}
					fix(d, "parameters", "工具 "+jsStr(d.V("name")))
				}
			}
		}
	}
	return
}

// ---- sampling ----
type sRule struct {
	min, max          float64
	hasMax, isInt, dropBelow bool
}

var (
	ruleTemp   = sRule{min: 0, max: 2, hasMax: true}
	ruleTopP   = sRule{min: 0, max: 1, hasMax: true}
	ruleTopK   = sRule{min: 1, isInt: true, dropBelow: true}
	ruleBudget = sRule{min: -1, max: 65535, hasMax: true, isInt: true}
)

func jsNumber(s string) (float64, bool) {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0, true
	}
	if strings.HasPrefix(t, "0x") || strings.HasPrefix(t, "0X") {
		n, err := strconv.ParseUint(t[2:], 16, 64)
		return float64(n), err == nil
	}
	if t == "Infinity" || t == "+Infinity" || t == "-Infinity" {
		return math.Inf(1), true
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil || strings.ContainsAny(t, "_") {
		return math.NaN(), true
	}
	return f, true
}

func clampField(h *Obj, key string, r sRule, label string, notes *[]string) {
	if h == nil {
		return
	}
	raw, ok := h.Get(key)
	if !ok || raw == nil {
		return
	}
	var n float64
	isNum := false
	if s, ok := raw.(string); ok && strings.TrimSpace(s) != "" {
		n, _ = jsNumber(s)
		isNum = true
	} else if f, ok := asNum(raw); ok {
		n, isNum = f, true
	}
	if !isNum || math.IsNaN(n) || math.IsInf(n, 0) {
		h.Del(key)
		*notes = append(*notes, label+" 无效已忽略")
		return
	}
	if r.isInt {
		n = math.Floor(n + 0.5)
	}
	if r.dropBelow && n < r.min {
		h.Del(key)
		*notes = append(*notes, label+"="+jsString(raw)+" 已忽略")
		return
	}
	if n < r.min {
		n = r.min
	}
	if r.hasMax && n > r.max {
		n = r.max
	}
	orig, wasNum := asNum(raw)
	if _, isStr := raw.(string); isStr || !wasNum || orig != n {
		h.Set(key, n)
		*notes = append(*notes, label+" "+string(MarshalJS(raw))+"→"+jsNum(n))
	}
}

func fixStop(h *Obj, key string, notes *[]string) {
	if h == nil {
		return
	}
	raw, ok := h.Get(key)
	if !ok || raw == nil {
		return
	}
	if s, ok := raw.(string); ok {
		if s == "" {
			h.Del(key)
			*notes = append(*notes, key+" 为空已忽略")
		}
		return
	}
	arr, ok := raw.([]any)
	if !ok {
		h.Del(key)
		*notes = append(*notes, key+" 无效已忽略")
		return
	}
	seen := map[string]bool{}
	var list []any
	for _, x := range arr {
		if s, ok := x.(string); ok && s != "" && !seen[s] {
			seen[s] = true
			list = append(list, s)
		}
	}
	if len(list) > 5 {
		*notes = append(*notes, key+" "+strconv.Itoa(len(list))+"个→前5个")
		list = list[:5]
	} else if len(list) != len(arr) {
		*notes = append(*notes, key+" 去掉了空值或重复")
	}
	if len(list) == 0 {
		h.Del(key)
		return
	}
	if len(list) != len(arr) {
		h.Set(key, list)
	}
}

func fixSampling(route string, p *Obj) []string {
	notes := []string{}
	if p == nil {
		return notes
	}
	if route == "/v1/chat/completions" {
		clampField(p, "temperature", ruleTemp, "temperature", &notes)
		clampField(p, "top_p", ruleTopP, "top_p", &notes)
		clampField(p, "top_k", ruleTopK, "top_k", &notes)
		fixStop(p, "stop", &notes)
		return notes
	}
	for _, gk := range []string{"generationConfig", "generation_config"} {
		gc := p.Obj(gk)
		if gc == nil {
			continue
		}
		clampField(gc, "temperature", ruleTemp, "temperature", &notes)
		for _, k := range []string{"topP", "top_p"} {
			clampField(gc, k, ruleTopP, k, &notes)
		}
		for _, k := range []string{"topK", "top_k"} {
			clampField(gc, k, ruleTopK, k, &notes)
		}
		for _, k := range []string{"stopSequences", "stop_sequences"} {
			fixStop(gc, k, &notes)
		}
		for _, tk := range []string{"thinkingConfig", "thinking_config"} {
			if tc := gc.Obj(tk); tc != nil {
				for _, k := range []string{"thinkingBudget", "thinking_budget"} {
					clampField(tc, k, ruleBudget, k, &notes)
				}
			}
		}
	}
	return notes
}