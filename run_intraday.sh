#!/usr/bin/env bash
# 盘中一键启动：采集循环 + 按间隔发布到 docs/（GitHub Pages）
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p logs
PUBLISH_EVERY="${PUBLISH_EVERY:-300}"
nohup python3 collector/collect_rt.py --loop --publish-every "$PUBLISH_EVERY" >> logs/intraday.log 2>&1 &
echo $! > logs/intraday.pid
echo "采集进程已启动 pid=$(cat logs/intraday.pid)  发布间隔=${PUBLISH_EVERY}s  日志=logs/intraday.log"
echo "盯盘页：python3 collector/serve.py  → http://127.0.0.1:8787/"
