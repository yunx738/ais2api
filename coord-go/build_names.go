package main

// Build model names (build-routing.js) and token estimate (build-context.js).
import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

const WIRE_PREFIX = "BUILD_ST_CONTEXT_V1\n"

var buildBases = []string{"gemini-4-argon", "gemini-4-carbon", "gemini-3.8-flash"}
var buildPrefixes = []string{"build/", "build-st/", "bridge/", "code/"}
var buildLevels = []struct {
	name string
	n    int
}{{"low", 1}, {"medium", 2}, {"high", 3}}

const (
	bShortPreset     = 2000
	bInlineBudget    = 45000
	bMaxBytes        = 8 * 1024 * 1024
	bMaxComposer     = 1024 * 1024
	bInlineFileBytes = 200 * 1024
	bMaxMedia        = 20 * 1024 * 1024
	bMaxSegments     = 20000
	codeSystemMax    = 30000
	codeToolInline   = 3000
)

type BuildErr struct {
	Status int
	Msg    string
	Code   string
}

func (e *BuildErr) Error() string { return e.Msg }
func bfail(msg string, status int, code string) *BuildErr {
	if status == 0 {
		status = 400
	}
	if code == "" {
		code = "build_context_invalid"
	}
	return &BuildErr{status, msg, code}
}

type BuildSpec struct {
	Requested, Prefix, Model, Level string
	Thinking                        int
}

func parseBuildModel(name string) (*BuildSpec, error) {
	prefix := ""
	for _, p := range buildPrefixes {
		if strings.HasPrefix(name, p) {
			prefix = p
			break
		}
	}
	if prefix == "" {
		return nil, nil
	}
	rest := name[len(prefix):]
	for _, b := range buildBases {
		if rest == b {
			return &BuildSpec{name, prefix, b, "high", 3}, nil
		}
		for _, l := range buildLevels {
			if rest == b+"-"+l.name {
				return &BuildSpec{name, prefix, b, l.name, l.n}, nil
			}
		}
	}
	return nil, herr(404, "Build 通道没有此模型："+name+"（可用："+strings.Join(buildModels(), ", ")+"）")
}

func buildModels() []string {
	var out []string
	for _, p := range buildPrefixes {
		for _, b := range buildBases {
			out = append(out, p+b)
			for _, l := range buildLevels {
				out = append(out, p+b+"-"+l.name)
			}
		}
	}
	return out
}

// CJK ~1 token/char, other text ~4 chars/token (UTF-16 length like JS).
func btokens(s string) int {
	cjk := 0
	for _, r := range s {
		if (r >= 0x3000 && r <= 0x9fff) || (r >= 0xac00 && r <= 0xd7af) || (r >= 0xff00 && r <= 0xffef) {
			cjk++
		}
	}
	l := jsLen(s)
	return cjk + (l-cjk+3)/4
}

func randHexN(n int) string { b := make([]byte, n); rand.Read(b); return hex.EncodeToString(b) }
