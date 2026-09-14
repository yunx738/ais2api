# ais2api

Dual-worker AI Studio reverse proxy with OpenAI-compatible API, per-account quota tracking (3.7-flash / 3.8-flash / pro), anti-truncation via synthetic `emit_answer` tool, and a web management dashboard.

## Layout
- `dual-runtime/code/` — runtime code (coordinator, workers, browser client, management UI)
- `dual-stage/` — staged/deployed code snapshots
- `app.env.example` — sanitized env template (real values live on the server)

## Security
Auth cookie files (`auth/auth-*.json`), `app.env`, and runtime state are excluded via `.gitignore`. Never commit credentials.

## Anti-truncation usage
Prepend `anti-truncation/` to a model name, e.g. `anti-truncation/gemini-3.8-flash`. The proxy injects a synthetic `emit_answer` tool (UPPERCASE schema) and auto-continues up to 3 rounds when the first response is truncated or misses the tool call.
