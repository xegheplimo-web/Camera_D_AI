#!/usr/bin/env bash
# Chạy toàn bộ script test:* tuần tự và ghi kết quả từng script.
set -u
cd "F:/Camera-D-AI/publish/Camera_D_AI" || exit 1
OUT="agent_logs/all-tests-$(date +%Y%m%d-%H%M%S).txt"
: > "$OUT"
PASS=0; FAIL=0; FAILED=""
# Fixture nào cũng tự gọi `next build` trước khi `next start`. Trong lúc app thật
# đang phục vụ trên :3000, build lại đè .next và đổ — h01 fail vì thế, không phải
# vì sản phẩm. Có build sẵn thì tái sử dụng nó.
if [ -f .next/BUILD_ID ]; then export SKIP_BUILD=1; fi
echo "SKIP_BUILD=${SKIP_BUILD:-0} (build sẵn: $( [ -f .next/BUILD_ID ] && echo yes || echo no ))" | tee -a "$OUT"
for s in $(node -e "console.log(Object.keys(require('./package.json').scripts).filter(k=>k.startsWith('test:')).join(' '))"); do
  start=$(date +%s)
  if npm run "$s" --silent > /tmp/one-test.log 2>&1; then
    PASS=$((PASS+1)); echo "PASS  $s  ($(( $(date +%s) - start ))s)" | tee -a "$OUT"
  else
    FAIL=$((FAIL+1)); FAILED="$FAILED $s"
    echo "FAIL  $s  ($(( $(date +%s) - start ))s)" | tee -a "$OUT"
    tail -12 /tmp/one-test.log | sed 's/^/      | /' >> "$OUT"
  fi
done
echo "----" >> "$OUT"
echo "TOTAL pass=$PASS fail=$FAIL" | tee -a "$OUT"
[ -n "$FAILED" ] && echo "FAILED:$FAILED" | tee -a "$OUT"
echo "RESULT_FILE=$OUT"
