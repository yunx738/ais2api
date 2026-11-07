package main

// HTTP client for the local no-browser service (127.0.0.1:2048). Calls are pinned to one account
// (X-Pin-Account + X-Build-Raw-Key). raw() is the Build endpoint /v1/x-build-raw.
import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Service struct {
	base   string
	key    string
	rawKey string
	hc     *http.Client
}

func ServiceFromFiles(dir string) (*Service, error) {
	env, err := os.ReadFile(dir + "/.env")
	if err != nil {
		return nil, err
	}
	m := regexp.MustCompile(`(?m)^PROXY_API_KEY=(.*)$`).FindStringSubmatch(string(env))
	key := ""
	if m != nil {
		key = strings.TrimSpace(strings.Split(strings.TrimSpace(m[1]), ",")[0])
	}
	rk, err := os.ReadFile(dir + "/build-raw.key")
	if err != nil {
		return nil, err
	}
	raw := strings.TrimSpace(string(rk))
	if key == "" || len(raw) < 16 {
		return nil, errors.New("headless keys required")
	}
	host := os.Getenv("HEADLESS_ADDR")
	if host == "" {
		host = "127.0.0.1:2048"
	}
	tr := &http.Transport{DisableKeepAlives: true, DisableCompression: true,
		DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext, ResponseHeaderTimeout: 0}
	return &Service{base: "http://" + host, key: key, rawKey: raw, hc: &http.Client{Transport: tr}}, nil
}

func (s *Service) Request(ctx context.Context, account, method, path string, body []byte) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.base+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.key)
	if account != "" {
		req.Header.Set("X-Pin-Account", account)
		req.Header.Set("X-Build-Raw-Key", s.rawKey)
	}
	return s.hc.Do(req)
}

type CallResult struct {
	Status  int
	Headers http.Header
	Text    []byte
	JSON    *Obj
	Err     error
}

func (c *CallResult) RetryAfter() string {
	if c.Headers == nil {
		return ""
	}
	return c.Headers.Get("Retry-After")
}

// Call: JSON request, fully buffered reply (max 64 MiB).
func (s *Service) Call(ctx context.Context, account, method, path string, obj any) *CallResult {
	var body []byte
	if obj != nil {
		body = MarshalJS(obj)
	}
	res, err := s.Request(ctx, account, method, path, body)
	if err != nil {
		return &CallResult{Err: err}
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 64*1024*1024+1))
	if err != nil {
		return &CallResult{Err: err, Status: res.StatusCode}
	}
	if len(b) > 64*1024*1024 {
		return &CallResult{Err: errors.New("reply too large")}
	}
	r := &CallResult{Status: res.StatusCode, Headers: res.Header, Text: b}
	r.JSON, _ = ParseObj(b)
	return r
}

type RawError struct {
	Status int
	Msg    string
}

func (e *RawError) Error() string { return e.Msg }

// Raw: Build op through the service. Returns the decoded body {s,t,path,data}.
func (s *Service) Raw(ctx context.Context, call *Obj, deadline time.Duration) (*Obj, error) {
	if deadline <= 0 {
		deadline = 120 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	payload := MarshalJS(call)
	req, _ := http.NewRequestWithContext(cctx, "POST", s.base+"/v1/x-build-raw", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.key)
	req.Header.Set("X-Build-Raw-Key", s.rawKey)
	res, err := s.hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, &RawError{499, "cancelled"}
		}
		if cctx.Err() != nil {
			return nil, &RawError{504, "raw call deadline"}
		}
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 96*1024*1024+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, &RawError{499, "cancelled"}
		}
		if cctx.Err() != nil {
			return nil, &RawError{504, "raw call deadline"}
		}
		return nil, err
	}
	if len(b) > 96*1024*1024 {
		return nil, errors.New("raw reply too large")
	}
	o, err := ParseObj(b)
	if err != nil {
		return nil, &RawError{502, "raw reply unparseable (" + strconv.Itoa(res.StatusCode) + ")"}
	}
	if res.StatusCode != 200 {
		m := o.Obj("error").Str("message")
		if m == "" {
			m = "raw call failed"
		}
		return nil, &RawError{res.StatusCode, clip(m, 300)}
	}
	return o, nil
}

func rawS(o *Obj) int  { n, _ := asSafeInt(o.V("s")); return int(n) }
func rawT(o *Obj) string { return jsStr(o.V("t")) }

// jsStr: String(v||'') for strings / anything.
func jsStr(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return jsString(v)
}