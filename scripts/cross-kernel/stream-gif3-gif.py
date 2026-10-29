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
comp = json.load(open(os.path.join(OUT, 'compose.json')))
os.makedirs(os.path.dirname(DEST) or '.', exist_ok=True)
lines = []
gaps = []
for r in [x for x in rec['rounds'] if x.get('ok')]:
    frames = [c for c in r['cells'] if c['kind'] == 'frame']
    tmin = frames[0]['tMs']
    for i, c in enumerate(frames):
        idx = i + (1 if i < len(frames) else 0)
        png = 'gif-%02d-r%d.png' % (i, r['round'])       # compose 里第 0 帧就是置空底
        gap = (c['tMs'] - tmin) if i else 0
        if i:
            gaps.append(gap - (frames[i - 1]['tMs'] - tmin))
        dur = MIN_MS if i == 0 else max(MIN_MS, min(MAX_MS, round(gap / max(gaps or [1]) * MAX_MS)))
        path = os.path.join(OUT, png)
        if not os.path.exists(path):
            print('缺帧', png)
            continue
        lines.append("file '%s'" % os.path.abspath(path))
        lines.append('duration %.3f' % (dur / 1000.0))
lines.append("file '%s'" % os.path.abspath(os.path.join(OUT, 'gif-%02d-r%d.png' % (len(frames) - 1, r['round']))))
lines.append('duration 1.800')
lp = os.path.join(OUT, 'gif-list.txt')
open(lp, 'w').write('\n'.join(lines) + '\n')
r0 = subprocess.run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', lp,
                     '-vf', 'fps=20,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', DEST],
                    capture_output=True, text=True)
if r0.returncode != 0:
    print((r0.stderr or '').split('\n')[-6:])
    sys.exit(1)
print('GIF →', DEST, os.path.getsize(DEST), 'B')
print('真实逐格间隔(ms) =', gaps, '⇒ 停留时长映射 min=%d max=%d' % (MIN_MS, MAX_MS))
print('复跑命令：ffmpeg -y -f concat -safe 0 -i %s -vf "fps=20,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" %s' % (lp, DEST))
