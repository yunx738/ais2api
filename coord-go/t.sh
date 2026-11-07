#!/bin/bash
# Side-by-side tests against the Go coordinator on 8891 (read-only mode).
K=$(python3 -c "import json;print(json.load(open('/opt/ais2api/dual-runtime/coordinator.json'))['apiKeys'][0])")
U=${U:-http://127.0.0.1:8891}
H=(-H "Authorization: Bearer $K" -H 'Content-Type: application/json')
ts() { while IFS= read -r l; do [ -n "$l" ] && echo "$(date +%M:%S) ${l:0:${W:-180}}"; done; }
case "$1" in
at)
  echo '== AT stream'
  curl -s -N -m 400 "${H[@]}" $U/v1/chat/completions -d '{"model":"anti-truncation/gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":"Write one short sentence about cats."}]}' | ts ;;
atns)
  echo '== AT non-stream'
  curl -s -m 400 -w '\nHTTP %{http_code}\n' "${H[@]}" $U/v1/chat/completions -d '{"model":"anti-truncation/gemini-3.8-flash","messages":[{"role":"user","content":"Write one short sentence about dogs."}]}' | cut -c1-400 ;;
fake)
  echo '== set fake'; curl -s "${H[@]}" $U/internal/ops/stream-mode -d '{"mode":"fake"}'; echo
  echo '== fake stream'
  curl -s -N -m 120 "${H[@]}" $U/v1/chat/completions -d '{"model":"gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":"Count 1 to 3"}]}' | ts
  echo '== fake stream, upstream error'
  curl -s -N -m 60 "${H[@]}" $U/v1/chat/completions -d '{"model":"gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]}]}' | ts
  echo '== native fake sse'
  curl -s -N -m 120 "${H[@]}" "$U/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse" -d '{"contents":[{"role":"user","parts":[{"text":"Say hi"}]}]}' | ts
  echo '== back to real'; curl -s "${H[@]}" $U/internal/ops/stream-mode -d '{"mode":"real"}'; echo ;;
native)
  echo '== native generate'
  curl -s -m 120 "${H[@]}" "$U/v1beta/models/gemini-3.8-flash:generateContent" -d '{"contents":[{"role":"user","parts":[{"text":"Say hi"}]}]}' | cut -c1-300; echo
  echo '== native real stream'
  curl -s -N -m 120 "${H[@]}" "$U/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse" -d '{"contents":[{"role":"user","parts":[{"text":"Say hi"}]}]}' | ts ;;
build)
  echo '== bridge/ build flash stream'
  W=300 curl -s -N -m 600 "${H[@]}" $U/v1/chat/completions -d '{"model":"bridge/gemini-3.8-flash-low","stream":true,"messages":[{"role":"system","content":"You are terse."},{"role":"user","content":"Reply with exactly: BUILD-OK"}]}' | ts ;;
sched)
  echo '== set group 主力 + priority on #31'
  curl -s "${H[@]}" $U/internal/ops/account-schedule -d '{"id":31,"groups":["主力"],"priority":5}'; echo
  echo '== group request'
  curl -s -m 90 "${H[@]}" -H 'X-AIS-Group: 主力' $U/v1/chat/completions -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Reply: G"}]}' | cut -c1-200; echo
  echo '== model suffix group'
  curl -s -m 90 "${H[@]}" $U/v1/chat/completions -d '{"model":"gemini-3.8-flash@g:主力","messages":[{"role":"user","content":"Reply: G2"}]}' | cut -c1-200; echo
  echo '== clear'
  curl -s "${H[@]}" $U/internal/ops/account-schedule -d '{"id":31,"groups":[],"priority":0}'; echo ;;
esac