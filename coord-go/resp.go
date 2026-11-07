package main

// Resp wraps one client response. It mirrors the Node res flags the scheduler relies on
// (headersSent / writableEnded / destroyed / 'close') and adds an early SSE mode:
// for stream requests the coordinator buffers itself (anti-truncation, fake streaming) it opens the
// event stream at once and keeps it alive; until the first real frame the stream is "soft", so the
// scheduler may still retry on another account, and errors are delivered as an OpenAI/Gemini
// stream error event instead of an HTTP status (new-api relays data: lines verbatim).
import (
	"context"
	"net/http"
	"strconv"
	"sync"
	"time"
)

type Resp struct {
	w           http.ResponseWriter
	fl          http.Flusher
	mu          sync.Mutex
	status      int
	headersSent bool
	ended       bool
	destroyed   bool
	soft        bool
	sseKind     string // "openai" | "gemini-sse" | "gemini-array"
	sseModel    string
	kaStop      chan struct{}
	done        chan struct{}
	ctx         context.Context
	cancel      context.CancelFunc
	closeFns    map[int]func()
	nextFn      int
	tap         *Metrics
	wroteArray  bool
}

func NewResp(w http.ResponseWriter, r *http.Request) *Resp {
	ctx, cancel := context.WithCancel(context.Background())
	x := &Resp{w: w, done: make(chan struct{}), ctx: ctx, cancel: cancel, closeFns: map[int]func(){}, status: 200}
	x.fl, _ = w.(http.Flusher)
	go func() {
		select {
		case <-r.Context().Done():
			x.Destroy()
		case <-x.done:
		}
	}()
	return x
}

func (r *Resp) Ctx() context.Context { return r.ctx }
func (r *Resp) Header() http.Header  { return r.w.Header() }
func (r *Resp) HeadersSent() bool    { r.mu.Lock(); defer r.mu.Unlock(); return r.headersSent }

// Started: real output has begun (no retry, no status change possible).
func (r *Resp) Started() bool { r.mu.Lock(); defer r.mu.Unlock(); return r.headersSent && !r.soft }
func (r *Resp) Soft() bool    { r.mu.Lock(); defer r.mu.Unlock(); return r.soft }
func (r *Resp) Gone() bool    { r.mu.Lock(); defer r.mu.Unlock(); return r.ended || r.destroyed }
func (r *Resp) Destroyed() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.destroyed
}
func (r *Resp) Ended() bool { r.mu.Lock(); defer r.mu.Unlock(); return r.ended }

func (r *Resp) OnClose(fn func()) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nextFn++
	r.closeFns[r.nextFn] = fn
	return r.nextFn
}
func (r *Resp) RemoveClose(id int) { r.mu.Lock(); delete(r.closeFns, id); r.mu.Unlock() }

func (r *Resp) fireClose() {
	r.mu.Lock()
	fns := make([]func(), 0, len(r.closeFns))
	for _, f := range r.closeFns {
		fns = append(fns, f)
	}
	r.closeFns = map[int]func(){}
	r.mu.Unlock()
	for _, f := range fns {
		f()
	}
}

func (r *Resp) stopKA() {
	if r.kaStop != nil {
		close(r.kaStop)
		r.kaStop = nil
	}
}

func (r *Resp) writeHeaderL(status int) {
	if r.headersSent {
		return
	}
	r.status = status
	r.headersSent = true
	r.w.WriteHeader(status)
}

// SetStatus records the status for the next write (res.statusCode=...).
func (r *Resp) SetStatus(s int) { r.mu.Lock(); r.status = s; r.mu.Unlock() }

func (r *Resp) writeL(b []byte, tap bool) bool {
	if r.ended || r.destroyed {
		return false
	}
	if !r.headersSent {
		r.writeHeaderL(r.status)
	}
	if tap && r.tap != nil && len(b) > 0 {
		r.tap.Write(b)
	}
	if len(b) > 0 {
		if _, err := r.w.Write(b); err != nil {
			return false
		}
	}
	if r.fl != nil {
		r.fl.Flush()
	}
	return true
}

func (r *Resp) Write(b []byte) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.writeL(b, true)
}

func (r *Resp) End(b []byte) {
	r.mu.Lock()
	if r.ended || r.destroyed {
		r.mu.Unlock()
		return
	}
	r.writeL(b, true)
	r.ended = true
	r.stopKA()
	close(r.done)
	r.mu.Unlock()
	r.fireClose()
}

func (r *Resp) Destroy() {
	r.mu.Lock()
	if r.ended || r.destroyed {
		r.mu.Unlock()
		return
	}
	r.destroyed = true
	r.stopKA()
	r.cancel()
	close(r.done)
	r.mu.Unlock()
	r.fireClose()
}

// JSON = the forward/http json() helper: only when nothing was sent yet.
func (r *Resp) JSON(status int, body any, headers map[string]string) {
	r.mu.Lock()
	if r.headersSent || r.ended || r.destroyed {
		soft := r.soft && !r.ended && !r.destroyed
		r.mu.Unlock()
		if soft {
			r.StreamError(status, body)
		}
		return
	}
	h := r.w.Header()
	h.Set("Content-Type", "application/json")
	for k, v := range headers {
		h.Set(k, v)
	}
	r.status = status
	r.mu.Unlock()
	r.End(MarshalJS(body))
}

// Fail = RequestScheduler.fail(): JSON error, stream error event, or connection abort.
func (r *Resp) Fail(status int, msg string) {
	r.mu.Lock()
	if r.ended || r.destroyed {
		r.mu.Unlock()
		return
	}
	if r.soft {
		r.mu.Unlock()
		r.StreamError(status, NewObj().Set("error", NewObj().Set("message", msg).Set("type", errType(status)).Set("code", status)))
		return
	}
	if r.headersSent {
		r.mu.Unlock()
		r.Destroy()
		return
	}
	r.mu.Unlock()
	r.JSON(status, NewObj().Set("error", NewObj().Set("message", msg)), nil)
}

func errType(status int) string {
	if status >= 500 {
		return "upstream_error"
	}
	if status == 429 {
		return "rate_limit_error"
	}
	return "invalid_request_error"
}

// OpenSSE starts an event stream before any content exists. kind: openai | gemini-sse | gemini-array.
func (r *Resp) OpenSSE(kind, model string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.headersSent || r.ended || r.destroyed {
		return
	}
	h := r.w.Header()
	if kind == "gemini-array" {
		h.Set("Content-Type", "application/json; charset=utf-8")
	} else {
		h.Set("Content-Type", "text/event-stream; charset=utf-8")
	}
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Accel-Buffering", "no")
	r.soft, r.sseKind, r.sseModel = true, kind, model
	r.writeHeaderL(200)
	if kind == "gemini-array" {
		r.writeL([]byte("["), false)
		r.wroteArray = true
	} else {
		r.writeL([]byte(": stream-open\n\n"), false)
	}
	stop := make(chan struct{})
	r.kaStop = stop
	go r.keepAlive(stop)
}

// Comment line every 5 s (keeps the coordinator<->new-api hop alive); for OpenAI streams also an
// empty-delta chunk every 15 s, which new-api forwards, so the far client never sees silence.
func (r *Resp) keepAlive(stop chan struct{}) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	n := 0
	id := "chatcmpl-" + uuid4()
	created := time.Now().Unix()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
		}
		n++
		r.mu.Lock()
		if !r.soft || r.ended || r.destroyed {
			r.mu.Unlock()
			return
		}
		switch {
		case r.sseKind == "openai" && n%3 == 0:
			f := NewObj().Set("id", id).Set("object", "chat.completion.chunk").Set("created", created).Set("model", r.sseModel).
				Set("choices", []any{NewObj().Set("index", 0).Set("delta", NewObj()).Set("finish_reason", nil)})
			r.writeL([]byte("data: "+string(MarshalJS(f))+"\n\n"), false)
		case r.sseKind == "gemini-array":
			r.writeL([]byte(" "), false)
		default:
			r.writeL([]byte(": keep-alive\n\n"), false)
		}
		r.mu.Unlock()
	}
}

// Commit: real frames follow; no more retries / keep-alive.
func (r *Resp) Commit() {
	r.mu.Lock()
	r.soft = false
	r.stopKA()
	r.mu.Unlock()
}

// StreamError ends a soft stream with an error event. payload: {error:{...}} (any shape with error).
func (r *Resp) StreamError(status int, payload any) {
	r.mu.Lock()
	if r.ended || r.destroyed {
		r.mu.Unlock()
		return
	}
	kind := r.sseKind
	r.soft = false
	r.stopKA()
	r.mu.Unlock()
	p := asObj(payload)
	e := p.Obj("error")
	if e == nil {
		e = NewObj().Set("message", "上游错误 ("+strconv.Itoa(status)+")")
	} else {
		e = e.Clone()
	}
	if !e.Has("code") {
		e.Set("code", status)
	}
	if !e.Has("type") && kind == "openai" {
		e.Set("type", errType(status))
	}
	out := NewObj().Set("error", e)
	switch kind {
	case "gemini-array":
		r.End([]byte(string(MarshalJS(out)) + "]"))
	default:
		r.End([]byte("data: " + string(MarshalJS(out)) + "\n\n"))
	}
}

func sleepMs(ms int64) { time.Sleep(time.Duration(ms) * time.Millisecond) }