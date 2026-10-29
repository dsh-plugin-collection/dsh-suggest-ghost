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
# ⚠️ 不能再用 -vf fps=20：那一步把 concat 的 duration 指令**全部重采样掉**
#   （实测 18 帧全变 50ms = 20fps，等于把"停留∝真实间隔"这句话当场作废）。
#   改用 -fps_mode passthrough，让每帧时长原样落到文件里。
cmd = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', lp,
       '-fps_mode', 'passthrough', '-vf', 'split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=none', DEST]
r0 = subprocess.run(cmd, capture_output=True, text=True)
if r0.returncode != 0:
    print((r0.stderr or '').split('\n')[-8:]); sys.exit(1)
print('GIF →', DEST, os.path.getsize(DEST), 'B')
print('目标时长(ms) =', [d for _, d, _ in plan])
print('复跑命令：' + ' '.join(cmd))
json.dump({'plan': [{'png': p, 'durMs': d, 'label': l} for p, d, l in plan]},
          open(os.path.join(OUT, 'gif-plan.json'), 'w'), ensure_ascii=False, indent=1)
