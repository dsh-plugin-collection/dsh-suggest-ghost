#!/usr/bin/env bash
# 改完跨内核驱动必跑：模板内反引号 / 模板语法 / 文件语法 三道检查。
#
# 为什么需要它：`const GY = String.raw\`...\`` 的正文里每出现一次反引号，模板就被提前闭合，
# 报错落在几十行之外（`Unexpected identifier`），看起来像别处写错了。2026-11-05 那一轮连踩三次。
set -u
F=${1:?用法: check-driver.sh <驱动文件>}
TMP=$(mktemp)
python3 - "$F" "$TMP" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf8').read()
m = re.search(r'const GY = String\.raw`([\s\S]*?)`;', src)
if m is None:
    print('无 GY 模板，跳过前两项'); sys.exit(0)
body = m.group(1)
open(sys.argv[2], 'w', encoding='utf8').write(body)
bad = body.count(chr(96))
print(f'GY 模板内反引号数 = {bad}（必须 0）')
sys.exit(1 if bad else 0)
PY
rc=$?
if [ $rc -ne 0 ]; then rm -f "$TMP"; echo "❌ 模板内有反引号：会提前闭合模板"; exit 1; fi
# ⚠️ 不能用 `node --check`：GY 正文是「若干语句」的裸片段（没有 export/import），
#    而 --check 按模块解析，对裸片段会误报。用 new Function 按函数体解析才对。
if ! node -e 'const fs=require("fs");new Function(fs.readFileSync(process.argv[1],"utf8"))' "$TMP" 2>/dev/null; then
  rm -f "$TMP"; echo "❌ GY 模板语法错"; exit 1
fi
rm -f "$TMP"
if ! node --check "$F" 2>/dev/null; then echo "❌ 驱动文件语法错"; exit 1; fi
echo "✅ 三道检查通过"
