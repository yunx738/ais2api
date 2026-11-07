package main

// Ordered JSON values. Request bodies are re-serialised the way JavaScript does it:
// object key order kept, numbers kept verbatim (json.Number), no HTML escaping.
import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"sort"
	"strconv"
	"unicode/utf8"
)

type Obj struct {
	keys []string
	m    map[string]any
}

func NewObj() *Obj { return &Obj{m: map[string]any{}} }

func (o *Obj) Get(k string) (any, bool) {
	if o == nil {
		return nil, false
	}
	v, ok := o.m[k]
	return v, ok
}
func (o *Obj) V(k string) any { v, _ := o.Get(k); return v }
func (o *Obj) Has(k string) bool {
	if o == nil {
		return false
	}
	_, ok := o.m[k]
	return ok
}
func (o *Obj) Set(k string, v any) *Obj {
	if _, ok := o.m[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.m[k] = v
	return o
}
func (o *Obj) Del(k string) bool {
	if o == nil {
		return false
	}
	if _, ok := o.m[k]; !ok {
		return false
	}
	delete(o.m, k)
	for i, x := range o.keys {
		if x == k {
			o.keys = append(o.keys[:i:i], o.keys[i+1:]...)
			break
		}
	}
	return true
}
func (o *Obj) Keys() []string {
	if o == nil {
		return nil
	}
	return o.keys
}
func (o *Obj) Len() int {
	if o == nil {
		return 0
	}
	return len(o.keys)
}

// Clone is shallow ({...o} in JS).
func (o *Obj) Clone() *Obj {
	n := &Obj{keys: append([]string(nil), o.keys...), m: make(map[string]any, len(o.m))}
	for k, v := range o.m {
		n.m[k] = v
	}
	return n
}
func (o *Obj) Str(k string) string { s, _ := o.V(k).(string); return s }
func (o *Obj) Obj(k string) *Obj  { x, _ := o.V(k).(*Obj); return x }
func (o *Obj) Arr(k string) []any { x, _ := o.V(k).([]any); return x }
func (o *Obj) Bool(k string) bool { b, _ := o.V(k).(bool); return b }

func (o *Obj) MarshalJSON() ([]byte, error) { return MarshalJS(o), nil }

func ParseJSON(b []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	v, err := decodeValue(dec, 0)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data")
	}
	return v, nil
}

func ParseObj(b []byte) (*Obj, error) {
	v, err := ParseJSON(b)
	if err != nil {
		return nil, err
	}
	o, ok := v.(*Obj)
	if !ok {
		return nil, errors.New("JSON object required")
	}
	return o, nil
}

func decodeValue(dec *json.Decoder, depth int) (any, error) {
	if depth > 10000 {
		return nil, errors.New("too deep")
	}
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	d, ok := t.(json.Delim)
	if !ok {
		return t, nil
	}
	switch d {
	case '{':
		o := NewObj()
		for dec.More() {
			kt, err := dec.Token()
			if err != nil {
				return nil, err
			}
			k, _ := kt.(string)
			v, err := decodeValue(dec, depth+1)
			if err != nil {
				return nil, err
			}
			o.Set(k, v)
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		return o, nil
	case '[':
		arr := []any{}
		for dec.More() {
			v, err := decodeValue(dec, depth+1)
			if err != nil {
				return nil, err
			}
			arr = append(arr, v)
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		return arr, nil
	}
	return nil, errors.New("unexpected delimiter")
}

func MarshalJS(v any) []byte {
	var b bytes.Buffer
	writeJS(&b, v, "", "")
	return b.Bytes()
}
func MarshalJSIndent(v any, indent string) []byte {
	var b bytes.Buffer
	writeJS(&b, v, indent, "")
	return b.Bytes()
}

func jsNum(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	a := math.Abs(f)
	if a == 0 || (a >= 1e-6 && a < 1e21) {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	s := strconv.FormatFloat(f, 'e', -1, 64)
	return s
}

func writeJSString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch c {
			case '"':
				b.WriteString(`\"`)
			case '\\':
				b.WriteString(`\\`)
			case '\n':
				b.WriteString(`\n`)
			case '\r':
				b.WriteString(`\r`)
			case '\t':
				b.WriteString(`\t`)
			case '\b':
				b.WriteString(`\b`)
			case '\f':
				b.WriteString(`\f`)
			default:
				if c < 0x20 {
					b.WriteString(`\u00`)
					b.WriteByte("0123456789abcdef"[c>>4])
					b.WriteByte("0123456789abcdef"[c&15])
				} else {
					b.WriteByte(c)
				}
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b.WriteString(`\ufffd`)
		} else {
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	b.WriteByte('"')
}

func writeJS(b *bytes.Buffer, v any, indent, pre string) {
	nl := func(p string) {
		if indent != "" {
			b.WriteByte('\n')
			b.WriteString(p)
		}
	}
	sep := ":"
	if indent != "" {
		sep = ": "
	}
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if x {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeJSString(b, x)
	case json.Number:
		b.WriteString(string(x))
	case int:
		b.WriteString(strconv.Itoa(x))
	case int64:
		b.WriteString(strconv.FormatInt(x, 10))
	case float64:
		b.WriteString(jsNum(x))
	case *Obj:
		if x == nil {
			b.WriteString("null")
			return
		}
		if len(x.keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteByte('{')
		for i, k := range x.keys {
			if i > 0 {
				b.WriteByte(',')
			}
			nl(pre + indent)
			writeJSString(b, k)
			b.WriteString(sep)
			writeJS(b, x.m[k], indent, pre+indent)
		}
		nl(pre)
		b.WriteByte('}')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k := range x {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		o := NewObj()
		for _, k := range keys {
			o.Set(k, x[k])
		}
		writeJS(b, o, indent, pre)
	case []any:
		if len(x) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			nl(pre + indent)
			writeJS(b, e, indent, pre+indent)
		}
		nl(pre)
		b.WriteByte(']')
	case []string:
		arr := make([]any, len(x))
		for i, s := range x {
			arr[i] = s
		}
		writeJS(b, arr, indent, pre)
	case json.RawMessage:
		if len(x) == 0 {
			b.WriteString("null")
		} else {
			b.Write(x)
		}
	default:
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(x); err != nil {
			b.WriteString("null")
			return
		}
		b.Write(bytes.TrimRight(buf.Bytes(), "\n"))
	}
}

// ---- loose accessors ----
func asObj(v any) *Obj      { o, _ := v.(*Obj); return o }
func asArr(v any) []any     { a, _ := v.([]any); return a }
func asStr(v any) (string, bool) { s, ok := v.(string); return s, ok }
func asNum(v any) (float64, bool) {
	switch x := v.(type) {
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	}
	return 0, false
}

// Number.isSafeInteger(v) && v>=0
func asCount(v any) (int64, bool) {
	f, ok := asNum(v)
	if !ok || f != math.Trunc(f) || f < 0 || f > 9007199254740991 {
		return 0, false
	}
	return int64(f), true
}
func asSafeInt(v any) (int64, bool) {
	f, ok := asNum(v)
	if !ok || f != math.Trunc(f) || math.Abs(f) > 9007199254740991 {
		return 0, false
	}
	return int64(f), true
}

// toAny converts encoding/json style generic values (map[string]any) into ordered ones.
func cloneDeep(v any) any {
	switch x := v.(type) {
	case *Obj:
		n := NewObj()
		for _, k := range x.keys {
			n.Set(k, cloneDeep(x.m[k]))
		}
		return n
	case []any:
		a := make([]any, len(x))
		for i, e := range x {
			a[i] = cloneDeep(e)
		}
		return a
	}
	return v
}
