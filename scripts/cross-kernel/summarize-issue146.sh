#!/usr/bin/env bash
# 把 issue146-probe 的**四份证据**汇总成一张表。
#
# 为什么单独抽出来：第一版汇总是我在命令行里现写的，锚点取成了 `chipRects[0].right`
# 而不是草稿真实末尾 —— 于是 0.2.2 上读出 `dx=46`、`cmd-only` 读出 `dx=4`，
# 差一点把「四代次全部正确」误判成「0.2.2 有缺陷」。**汇总脚本本身也要可复核**，
# 否则它就是在制造假红/假绿。
#
# 锚点口径（与 `verify()` 同源）：
#   - 草稿以文本结尾 ⇒ 取最后一个文本节点的末字符矩形 `lastTextRight`
#   - 草稿以 chip 结尾（其后无文本）⇒ 取最后一个 chip 的 `right`
#
# 用法：scripts/cross-kernel/summarize-issue146.sh
set -u
cd "$(dirname "$0")/../.." || exit 1
python3 - <<'PY'
import glob, json

rows = []
for path in sorted(glob.glob('scripts/cross-kernel/out/issue146-probe-*.json')):
    data = json.load(open(path, encoding='utf8'))
    gen = data.get('gen', '?')
    warm = (data.get('warmup') or {}).get('ok')
    for name, case in (data.get('cases') or {}).items():
        snap = (case or {}).get('snap') or {}
        ghost = snap.get('ghost') or {}
        anchor = snap.get('lastTextRight')
        if anchor is None:
            chips = snap.get('chipRects') or []
            anchor = chips[-1]['right'] if chips else None
        left = ghost.get('left')
        dx = (left - anchor) if (anchor is not None and left is not None) else None
        rows.append({
            'gen': gen, 'case': name, 'form': ghost.get('form'),
            'dx': dx, 'shown': ghost.get('shown'), 'reject': ghost.get('reject'),
            'warm': warm,
        })

if not rows:
    print('没有证据文件（先跑 issue146-probe.mjs）')
    raise SystemExit

print(f"{'代次':<16}{'用例':<16}{'形态':<30}{'dx':>6}{'shown':>7}{'reject':>8}{'warmup':>8}")
print('-' * 94)
for r in rows:
    dx = '-' if r['dx'] is None else str(r['dx'])
    print(f"{r['gen']:<16}{r['case']:<16}{str(r['form'] or '-'):<30}{dx:>6}"
          f"{str(r['shown']):>7}{str(r['reject'] or '-'):>8}{str(r['warm']):>8}")

# 汇总判据：**「拿到有效读数」= shown 且 dx 有值**。
#   ⚠️ 刻意不用探针里的 `warmup` 字段：那条判据问的是错的问题（它在回合刚发出时等幽灵，
#   而幽灵要等载荷落地才出现），修了两版仍不可靠。用例本身成不成立，看 cases 里的读数
#   就够了 —— 有 shown=true 且有 dx，就是这一帧真的被量到了。
judged = [r for r in rows if r['shown'] is True and r['dx'] is not None]
undetermined = [r for r in rows if not (r['shown'] is True and r['dx'] is not None)]
bad = [r for r in judged if abs(r['dx']) > 4]
print()
print(f"判定 {len(judged)} 例 / 未判定 {len(undetermined)} 例 / 超出 ±4px 容差 {len(bad)} 例")
if bad:
    print('⚠️ 超容差：')
    for r in bad:
        print(f"   {r['gen']} {r['case']} dx={r['dx']}")
if undetermined:
    print('未判定（不作为通过，也不作为失败）：')
    for r in undetermined:
        print(f"   {r['gen']} {r['case']} warmup={r['warm']} dx={r['dx']}")
PY
