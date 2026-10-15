#!/bin/sh
set -e
mkdir -p "$DATA_DIR"
# Litestream (https://litestream.io/reference/restore/ , https://litestream.io/reference/replicate/):
# restore the database if the volume is empty and a replica exists, then run the app as Litestream's child so
# replication stops cleanly with it. Container disks on the managed platform are ephemeral, so this restore is
# what makes a tenant's data survive a cold start.
#
# Two ways to point at the replica, both optional:
#   LITESTREAM_URL      command-line mode, e.g. s3://bucket/tenants/acme/app.db (credentials from
#                       LITESTREAM_ACCESS_KEY_ID / LITESTREAM_SECRET_ACCESS_KEY, endpoint from AWS_ENDPOINT)
#   LITESTREAM_CONFIG   config-file mode, a Litestream 0.5 YAML (see infra/litestream/litestream.yml);
#                       /etc/litestream.yml is also picked up if mounted there
APP="node dist/index.js"
if command -v litestream >/dev/null 2>&1; then
  if [ -n "$LITESTREAM_URL" ]; then
    if [ ! -f "$DATA_DIR/app.db" ]; then
      echo "entrypoint: no local database, attempting restore from $LITESTREAM_URL"
      litestream restore -if-replica-exists -o "$DATA_DIR/app.db" "$LITESTREAM_URL" || true
    fi
    echo "entrypoint: running with Litestream replication to $LITESTREAM_URL"
    exec litestream replicate -exec "$APP" "$DATA_DIR/app.db" "$LITESTREAM_URL"
  fi
  CFG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
  if [ -f "$CFG" ]; then
    if [ ! -f "$DATA_DIR/app.db" ]; then
      echo "entrypoint: no local database, attempting restore using $CFG"
      litestream restore -config "$CFG" -if-replica-exists -if-db-not-exists "$DATA_DIR/app.db" || true
    fi
    echo "entrypoint: running with Litestream replication from $CFG"
    exec litestream replicate -config "$CFG" -exec "$APP"
  fi
fi
exec $APP
