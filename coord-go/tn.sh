#!/bin/bash
# End-to-end through new-api (as clients see it). Uses new-api token #1.
TK=$(docker exec newapi-postgres sh -c 'psql -U "$POSTGRES_USER" -d "${POSTGRES_DB:-new-api}" -Atc "select key from tokens where id=1"')
NA=http://127.0.0.1:28600
H=(-H "Authorization: Bearer sk-$TK" -H 'Content-Type: application/json')
BAD='[{"type":"text","text":"hi"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]'
case "$1" in
ok)
  echo '== new-api AT stream'
  curl -s -N -m 300 "${H[@]}" $NA/v1/chat/completions -d '{"model":"anti-truncation/gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":"One sentence about snow."}]}' | cut -c1-170 ;;
errs)
  echo '== new-api AT error, stream'
  curl -s -N -m 300 -w '\nHTTP %{http_code}\n' "${H[@]}" $NA/v1/chat/completions -d '{"model":"anti-truncation/gemini-3.8-flash","stream":true,"messages":[{"role":"user","content":'"$BAD"'}]}' | cut -c1-420
  echo '== new-api AT error, non-stream'
  curl -s -m 300 -w '\nHTTP %{http_code}\n' "${H[@]}" $NA/v1/chat/completions -d '{"model":"anti-truncation/gemini-3.8-flash","messages":[{"role":"user","content":'"$BAD"'}]}' | cut -c1-420 ;;
pin)
  echo '== new-api pinned model (@31)'
  curl -s -m 120 -w '\nHTTP %{http_code}\n' "${H[@]}" $NA/v1/chat/completions -d '{"model":"gemini-3.8-flash@31","messages":[{"role":"user","content":"Reply: P"}]}' | cut -c1-300
  echo '== new-api pinned via header'
  curl -s -m 120 -w '\nHTTP %{http_code}\n' "${H[@]}" -H 'X-AIS-Account: 31' $NA/v1/chat/completions -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Reply: P2"}]}' | cut -c1-300 ;;
esac