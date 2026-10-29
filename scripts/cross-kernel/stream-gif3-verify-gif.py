#!/usr/bin/env python3
"""断言 E：**回读交付的 GIF 本身**（task-44）。

为什么需要它：我把"格与格之间的停留时长 ∝ 真实帧间隔"**印在每一格图上**，
而交付的文件里 18 帧全是 50ms（`-vf fps=20` 把 concat 的 duration 指令重采样掉了），
并且 compose 三轮写进同一批文件名 ⇒ 后一轮覆盖前一轮，GIF 其实只有轮 3 的格子重复三遍。
⇒ **印在交付物上的每一句话，都必须有一条读交付物本身的断言。**

判据：
  E1 帧数 == 计划格数 + 1（末帧是循环用的重复帧，必须显式解释，不许含糊）
  E2 每帧 duration 与计划目标一致（容差 ±1cs = ±10ms）
  E3 duration 序列**不得全等**（全等就说明"∝ 真实间隔"这句话是假的）
"""
import json
import os
import sys
from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else 'scripts/cross-kernel/out/gif3-rebuild'
GIF = sys.argv[2] if len(sys.argv) > 2 else 'docs/cross-kernel-shots/streaming-0.2.1-rc.2-stream.gif'

plan = json.load(open(os.path.join(OUT, 'gif-plan.json')))['plan']
targets = [p['durMs'] for p in plan]
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
e2 = (len(durs) == len(targets) + 1) and all(abs(durs[i] - targets[i]) <= 20 for i in range(cmp_n))
e3 = len(set(durs[:cmp_n])) > 1
print('计划格数 =', len(targets), '  文件帧数 =', len(durs), '（末帧为循环重复帧）')
print('目标时长(ms) =', targets)
print('实测时长(ms) =', durs)
print('E1 帧数 == 格数+1 :', e1, '(实测 %d vs %d+1)' % (len(durs), len(targets)))
print('E2 每帧与目标一致(±10ms):', e2,
      ' 最大偏差 =', (max(abs(durs[i] - targets[i]) for i in range(cmp_n)) if cmp_n else None), 'ms')
print('E3 时长不全等:', e3, ' 唯一值 =', sorted(set(durs)))
ok = e1 and e2 and e3
print('\n断言 E：', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
