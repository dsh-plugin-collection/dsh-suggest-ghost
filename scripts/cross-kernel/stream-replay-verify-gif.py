#!/usr/bin/env python3
"""断言 E（task-46 重放版）：**回读交付的 GIF 本身**。

  E1 帧数 == 计划格数 + 1（末帧是循环重复帧，显式解释）
  E2 每帧 duration 与计划目标一致（容差 ±20ms：PIL 按 10ms 粒度取整）
  E3 duration 序列不得全等（全等就说明"停留∝真实间隔"这句话是假的）
  E4 **把 GIF 合成回画面**再逐格量墨迹（ffmpeg 抽内容变化帧；PIL 裸 seek 读到的是增量帧，
     手工 alpha 累加会算错 disposal —— 两次都坑过人）；组边界按 gif-plan.json 的"轮N"标签切，
     **不假设每组几格**（三轮的帧数本来就不同：3/4/4）
  E5 墨迹判据用**局部对比度**，不用绝对颜色：本沙箱是深色主题，§17 那套"冷灰 b>r"
     在这里恒读 0 —— 那又是一次"断言通过 ≠ 问对了问题"。
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter

from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else 'scripts/cross-kernel/out/replay'
GIF = sys.argv[2] if len(sys.argv) > 2 else 'docs/cross-kernel-shots/streaming-0.2.1-rc.2-replay.gif'
plan = json.load(open(os.path.join(OUT, 'gif-plan.json')))['plan']
# plan 最后一项是**循环重复帧**（label='循环帧'），它不是"格" ⇒ 从 targets/labels 里排除，
# 否则 E1 会拿"格数+1"去比"格数+2"，永远不过。（上一版就是这个。）
cells_plan = [p for p in plan if p.get('label') != '循环帧']
targets = [p['durMs'] for p in cells_plan]
labels = [p['label'] for p in cells_plan]

im = Image.open(GIF)
durs = []
n = 0
while True:
    try:
        im.seek(n)
    except EOFError:
        break
    durs.append(int(im.info.get('duration') or 0))
    n += 1

e1 = (len(durs) == len(targets) + 1)
cmp_n = min(len(durs), len(targets))
e2 = all(abs(durs[i] - targets[i]) <= 20 for i in range(cmp_n))
e3 = len(set(durs[:cmp_n])) > 1

tmpd = tempfile.mkdtemp(prefix='gifE-')
# 抽**全部**帧（不做"内容变化"筛选 —— 那个 select 表达式在本机会把帧序弄乱，
# 实测出现"三组起点墨迹完全相同"的假形状），再用**内容哈希去重**得到不同画面。
subprocess.run(['ffmpeg', '-y', '-i', GIF, os.path.join(tmpd, 'f%03d.png')],
               capture_output=True, text=True)
import hashlib
allp = sorted(glob.glob(os.path.join(tmpd, 'f*.png')))
seen = {}
for f in allp:
    h = hashlib.sha256(open(f, 'rb').read()).hexdigest()[:16]
    if h not in seen:
        seen[h] = f
paths = sorted(seen.values(), key=lambda x: int(os.path.basename(x)[1:-4]))
print('抽出全部帧 =', len(allp), ' 去重后不同画面 =', len(paths))


# 合成帧的版式（与 stream-replay-gif.py 必须一致）：标注 44px + 截图 + 口径行
CAP_TOP = 44
SRC_H = None      # 截图区高度，从第一格推出来


def ink_local(path):
    """局部对比度：偏离**截图区背景**众数的像素数，深色/浅色主题都成立。

    ⚠️ 必须先裁掉我自己加的标注带：整帧数会把"轮N 起点 · 产品 overlay 置空"这行标签
    也算成墨迹（实测起点格 6297，全是标签像素）⇒ E4a 看着像"置空没成功"，
    其实是我的**标注污染了被测区域**。判据要量被测对象，不能量自己的注释。
    """
    global SRC_H
    im2 = Image.open(path).convert('RGB')
    w, h = im2.size
    if SRC_H is None:
        SRC_H = h - CAP_TOP - 96      # 96 = 底部口径带
    crop = im2.crop((0, CAP_TOP, w, min(h, CAP_TOP + SRC_H)))
    cw, ch = crop.size
    px = crop.load()
    bg = Counter(px[x, y] for y in range(0, ch, 2) for x in range(0, cw, 2)).most_common(1)[0][0]
    n2 = 0
    for y in range(ch):
        for x in range(100, cw):
            if sum(abs(a - b) for a, b in zip(px[x, y], bg)) > 90:
                n2 += 1
    return n2


inks = [ink_local(f) for f in paths]
shutil.rmtree(tmpd, ignore_errors=True)
groups = []   # 组内是格子序号，按标签里的"轮N"切；不假设每组几格
cur = None
for i, lab in enumerate(labels):
    rnd = lab.split(' ')[0] if lab.startswith('轮') else cur
    if rnd != cur:
        cur = rnd
        groups.append([])
    groups[-1].append(i)
gvals = [[inks[i] for i in g] for g in groups if len(g) >= 2]
e4a = all(g[0] < 500 for g in gvals)
e4b = all(all(g[j] <= g[j + 1] * 1.05 + 50 for j in range(len(g) - 1)) for g in gvals)
e4c = len(paths) == len(targets) + 1
e4 = e4a and e4b and e4c

print('计划格数 =', len(targets), '  文件帧数 =', len(durs), '  合成画面数 =', len(paths))
print('目标时长(ms) =', targets)
print('实测时长(ms) =', durs)
print('E1 帧数 == 格数+1 :', e1)
print('E2 每帧与目标一致(±20ms):', e2, ' 最大偏差 =',
      (max(abs(durs[i] - targets[i]) for i in range(cmp_n)) if cmp_n else None), 'ms')
print('E3 时长不全等:', e3, ' 唯一值 =', sorted(set(durs)))
print('合成后逐格墨迹（局部对比度，深色主题下绝对颜色判据恒 0）：')
for g, gv in zip(groups, gvals):
    print('  ', labels[g[0]], gv)
print('E4a 起点格合成后为空(<500):', e4a, ' E4b 组内不递减:', e4b, ' E4c 合成画面数==格数+1:', e4c)

ok = e1 and e2 and e3 and e4
print('\n断言 E：', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
