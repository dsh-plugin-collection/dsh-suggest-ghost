#!/usr/bin/env python3
"""把 compose 出来的 GIF 帧拼成动图：**每格停留时长按该格真实间隔比例**（task-44）。

不做"统一 1500ms"：真实间隔 77ms 与 352ms 差 4.6 倍，统一停留会把比例抹平，
而这张图唯一要传达的就是"每一步隔了多久"。
映射：min=260ms（短到看不见的间隔也要留够阅读时间）、max=1600ms，线性对应真实 ms。
每格自带真实 t= 与字符数标注，所以"慢放倍数"不是一个统一数字 —— 图头按真实区间写。
"""
import json
import os
import subprocess
import sys

OUT = sys.argv[1] if len(sys.argv) > 1 else 'scripts/cross-kernel/out/gif3-rebuild'
DEST = sys.argv[2] if len(sys.argv) > 2 else 'docs/cross-kernel-shots/streaming-0.2.1-rc.2-stream.gif'
MIN_MS, MAX_MS = 260, 1600
rec = json.load(open(os.path.join(OUT, 'record.json')))
os.makedirs(os.path.dirname(DEST) or '.', exist_ok=True)
MIN_MS, MAX_MS = 260, 1600
plan = []          # [(png, 目标停留 ms, 标注)]
for r in [x for x in rec['rounds'] if x.get('ok')]:
    frames = [c for c in r['cells'] if c['kind'] == 'frame']
    tmin = frames[0]['tMs']
    gaps = [0] + [frames[i]['tMs'] - frames[i - 1]['tMs'] for i in range(1, len(frames))]
    biggest = max(gaps) or 1
    for i, c in enumerate(frames):
        dur = MIN_MS if i == 0 else max(MIN_MS, min(MAX_MS, round(gaps[i] / biggest * MAX_MS)))
        plan.append(('gif-r%d-%02d.png' % (r['round'], i + 1), dur,
                     '轮%d %s t=+%dms %d字符' % (r['round'], '终帧' if c['final'] else '步%d' % (i + 1), c['tMs'], c['chars'])))
    plan.append(('gif-r%d-00.png' % r['round'], 320, '轮%d 置空起点' % r['round']))
lines = []
for png, dur, _ in plan:
    path = os.path.join(OUT, png)
    if not os.path.exists(path):
        print('缺帧', png); continue
    lines.append("file '%s'" % os.path.abspath(path))
    lines.append('duration %.3f' % (dur / 1000.0))
lines.append("file '%s'" % os.path.abspath(os.path.join(OUT, plan[-1][0])))
lines.append('duration %.3f' % (plan[-1][1] / 1000.0))
lp = os.path.join(OUT, 'gif-list.txt')
open(lp, 'w').write('\n'.join(lines) + '\n')
# ⚠️ 编码这一步换成了 **PIL 直接写每帧 duration**，不再走 ffmpeg 的 concat + 调色板滤镜链。
#   两次实测教训：
#    - `-vf fps=20` 会把 concat 的 duration 指令**重采样掉** ⇒ 18 帧全变 50ms；
#    - 改 `-vsync passthrough` 后又把 9 帧**吃掉 5 帧**（只剩 4 帧）——
#      断言 E 回读文件才发现，光看脚本"算了映射"不算数。
#   PIL 的 save(save_all=True, duration=[...]) 是逐帧显式写延时，没有中间重采样，可回读。
from PIL import Image
frames = []
durs = []
for png, dur, _ in plan:
    path = os.path.join(OUT, png)
    if not os.path.exists(path):
        print('缺帧', png); continue
    frames.append(Image.open(path).convert('RGB').convert('P', palette=Image.ADAPTIVE, colors=128))
    durs.append(int(dur))
# 末帧：给循环用的重复帧画一个角标，让它**与前一帧真的不同**。
# 否则 PIL 会把"内容完全相同 + 紧跟其后"的两帧**合并成一帧**（实测 320ms 与 700ms
# 被并成 1020ms、帧数少 1）—— 那又是一次"产物与声明不对齐"，只能靠回读发现。
from PIL import ImageDraw, ImageFont
last = frames[-1].convert('RGB')
d = ImageDraw.Draw(last)
try:
    fnt = ImageFont.truetype('/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 22)
    d.text((12, last.size[1] - 34), '↻ 循环到起点', font=fnt, fill=(110, 124, 138))
except Exception:
    d.rectangle([8, last.size[1] - 30, 150, last.size[1] - 10], outline=(110, 124, 138))
frames.append(last.convert('P', palette=Image.ADAPTIVE, colors=128))
durs.append(700)     # 末帧=循环用的重复帧（断言 E1 按"格数+1"核对）
json.dump({'plan': [{'png': p, 'durMs': d, 'label': l} for p, d, l in plan]},
          open(os.path.join(OUT, 'gif-plan.json'), 'w'), ensure_ascii=False, indent=1)
os.makedirs(os.path.dirname(DEST) or '.', exist_ok=True)
frames[0].save(DEST, save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=False)
print('GIF →', DEST, os.path.getsize(DEST), 'B  帧数 =', len(frames))
print('目标时长(ms) =', durs)
print('复跑命令：python3 scripts/cross-kernel/stream-gif3-gif.py %s %s' % (OUT, DEST))
