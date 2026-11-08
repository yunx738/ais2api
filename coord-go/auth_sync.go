package main

// syncAuthRequired: the no-browser service marks an account auth_required when Google sends it to the sign-in page.
// Mirror that as an invalid/login_required flag so the account leaves dispatch and the nightly re-login queue picks
// it up. Accounts whose login file changed in the last 15 minutes are skipped (a fresh re-login the service has not
// reloaded yet). A flag set this way is cleared once the login file is replaced and the service reports it ready.
// Same behaviour as the Rust coordinator (app.rs sync_auth_required).
import (
	"context"
	"os"
	"strings"
	"time"
)

func (a *App) syncAuthRequired() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	r := a.svc.Call(ctx, "", "GET", "/api/accounts", nil)
	if r == nil || r.Err != nil || r.Status != 200 {
		return
	}
	raw, err := ParseJSON(r.Text)
	if err != nil {
		return
	}
	list, _ := raw.([]any)
	if o := asObj(raw); o != nil {
		list = o.Arr("accounts")
	}
	bad := map[string]string{}
	ready := map[string]bool{}
	for _, x := range list {
		o := asObj(x)
		if o == nil {
			continue
		}
		id := strings.ToLower(o.Str("id"))
		switch o.Str("state") {
		case "auth_required":
			if id != "" {
				bad[id] = clipRunes(o.Str("message"), 160)
			}
		case "ready":
			ready[id] = true
		}
	}
	mtime := func(id int) (int64, bool) {
		st, err := os.Stat(a.acc.file(id))
		if err != nil {
			return 0, false
		}
		return st.ModTime().UnixMilli(), true
	}
	now := nowMs()
	var marked, cleared []int
	a.mu.Lock()
	ids := append([]int(nil), a.core.Ids...)
	for _, id := range ids {
		email := strings.ToLower(a.acc.Email(id))
		if f := a.core.Flag(id); f != nil {
			if f.Str("status") == "invalid" && f.Str("source") == "headless" && ready[email] {
				at, _ := asNum(f.V("at"))
				if mt, ok := mtime(id); ok && float64(mt) > at {
					a.core.SetFlag(id, nil)
					a.core.ClearCooldown(id)
					cleared = append(cleared, id)
				}
			}
			continue
		}
		if a.disp.busy(id) > 0 || email == "" {
			continue
		}
		msg, ok := bad[email]
		if !ok {
			continue
		}
		if mt, ok := mtime(id); ok && now-mt < 900000 {
			continue
		}
		a.core.SetFlag(id, NewObj().Set("status", "invalid").Set("reason", "login_required").Set("at", now).
			Set("source", "headless").Set("message", msg))
		marked = append(marked, id)
	}
	if len(marked) > 0 || len(cleared) > 0 {
		a.core.Checkpoint()
	}
	a.mu.Unlock()
	for _, id := range cleared {
		logf("[Auth] #%d restored: login file replaced and the no-browser service reports it ready", id)
	}
	for _, id := range marked {
		logf("[Auth] #%d marked invalid (login_required): no-browser service reports the sign-in session expired", id)
	}
}
