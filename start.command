#!/bin/bash
# 双击在本地预览网站（关闭这个终端窗口即停止）
cd "$(dirname "$0")" || exit 1
PORT=8765
while lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done
URL="http://127.0.0.1:$PORT/"
echo "带壳截图已启动：$URL"
echo "关闭此窗口即可停止。"
(sleep 0.8 && open "$URL") &
exec python3 -m http.server "$PORT" --bind 127.0.0.1 --directory public
