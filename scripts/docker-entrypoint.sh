#!/bin/sh
# 容器入口：把 /app/data 数据卷的属主修正为 node，再以非 root 身份启动服务。
# 场景：docker compose 首次挂载空目录时，宿主目录通常属于 root，镜像内的 node 用户无法写入 SQLite/WAL。
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/ipdb"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || \
    echo "[entrypoint] 警告：无法修正 $DATA_DIR 的属主，若出现写入失败请手动 chown 1000:1000 该目录" >&2
  exec su-exec node "$@"
fi

# 已通过 compose 的 user: 指定为非 root 时直接启动
exec "$@"
