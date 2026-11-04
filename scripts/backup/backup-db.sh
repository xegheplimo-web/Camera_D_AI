#!/usr/bin/env bash
# H-02a — sao lưu app_db + diễn tập restore tự động.
# Chạy: bash scripts/backup/backup-db.sh [--verify]
# Không in mật khẩu; đọc container name từ env CAMDAI_PG_CONTAINER (mặc định camdai-pg).

set -euo pipefail

# git-bash (MSYS) tự đổi "/tmp/..." thành đường dẫn Windows khi gọi docker → pg_dump ghi ra
# C:/Users/.../Temp và fail "No such file or directory" khi chạy qua Task Scheduler.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

CONTAINER="${CAMDAI_PG_CONTAINER:-camdai-pg}"
DB="${CAMDAI_PG_DB:-app_db}"
DEST="${CAMDAI_BACKUP_DIR:-F:/Camera-D-AI/runtime/backups}"
KEEP="${CAMDAI_BACKUP_KEEP:-14}"
STAMP="$(date +%Y%m%d_%H%M%S)"
FILE="app_db_${STAMP}.dump"

mkdir -p "$DEST"

echo "[1/4] pg_dump -Fc ${DB}"
docker exec "$CONTAINER" pg_dump -U postgres -d "$DB" -Fc -f "/tmp/${FILE}"
docker cp "${CONTAINER}:/tmp/${FILE}" "${DEST}/${FILE}"
docker exec "$CONTAINER" rm -f "/tmp/${FILE}"

SIZE=$(stat -c %s "${DEST}/${FILE}")
echo "      -> ${DEST}/${FILE} (${SIZE} bytes)"

echo "[2/4] kiểm tra dump đọc được (pg_restore --list)"
docker cp "${DEST}/${FILE}" "${CONTAINER}:/tmp/verify.dump"
COUNT=$(docker exec "$CONTAINER" pg_restore -l /tmp/verify.dump | grep -c "TABLE DATA" || true)
docker exec "$CONTAINER" rm -f /tmp/verify.dump
if [ "$COUNT" -lt 10 ]; then
  echo "      LỖI: dump chỉ có ${COUNT} bảng dữ liệu — nghi file hỏng hoặc DB rỗng." >&2
  exit 1
fi
echo "      -> ${COUNT} bảng dữ liệu"

if [ "${1:-}" = "--verify" ]; then
  echo "[3/4] diễn tập restore sang app_db_restore_drill"
  docker exec "$CONTAINER" psql -U postgres -q -c "drop database if exists app_db_restore_drill" \
    -c "create database app_db_restore_drill"
  docker cp "${DEST}/${FILE}" "${CONTAINER}:/tmp/drill.dump"
  docker exec "$CONTAINER" pg_restore -U postgres -d app_db_restore_drill --no-owner --no-acl /tmp/drill.dump
  docker exec "$CONTAINER" rm -f /tmp/drill.dump

  echo "[4/4] so khớp từng bảng bằng md5(string_agg)"
  FAIL=0
  for t in tenants users cameras camera_settings events assets knowledge_items knowledge_images audit_log; do
    A=$(docker exec "$CONTAINER" psql -U postgres -d "$DB" -tAc \
      "select coalesce(md5(string_agg(t::text,'|' order by t::text)),'EMPTY') from $t t" 2>/dev/null || echo ERR)
    B=$(docker exec "$CONTAINER" psql -U postgres -d app_db_restore_drill -tAc \
      "select coalesce(md5(string_agg(t::text,'|' order by t::text)),'EMPTY') from $t t" 2>/dev/null || echo ERR)
    if [ "$A" = "$B" ]; then echo "      $t OK"; else echo "      $t MISMATCH"; FAIL=1; fi
  done
  docker exec "$CONTAINER" psql -U postgres -q -c "drop database app_db_restore_drill"
  # Marker cho gate M8: chứng minh lần diễn tập GẦN NHẤT đã thật sự chạy và kết quả.
  # Ghi cả khi thất bại — một marker "ok=false" là bằng chứng trung thực, còn thiếu
  # marker nghĩa là chưa từng verify.
  if [ "$FAIL" = "0" ]; then
    printf '{"ok": true, "at": "%s", "dump": "%s", "tables": 9, "check": "md5(string_agg) per table"}\n' \
      "$(date -Iseconds)" "$FILE" > "${DEST}/restore_verified.json"
    echo "DIỄN TẬP RESTORE PASS"
  else
    printf '{"ok": false, "at": "%s", "dump": "%s", "check": "md5(string_agg) per table"}\n' \
      "$(date -Iseconds)" "$FILE" > "${DEST}/restore_verified.json"
    echo "DIỄN TẬP RESTORE THẤT BẠI" >&2
    exit 1
  fi
else
  echo "[3/4] bỏ qua diễn tập (thêm --verify để chạy)"
  echo "[4/4] bỏ qua so khớp"
fi

echo "[dọn] xoá dump cũ hơn ${KEEP} ngày"
find "$DEST" -name 'app_db_*.dump' -type f -mtime "+${KEEP}" -print -delete || true

echo "XONG: ${DEST}/${FILE}"
