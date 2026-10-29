#!/usr/bin/env python3
"""重放版 GIF（task-46）：格序 `起点 → 逐帧 → 终帧`，每格停留∝真实帧间隔，disposal=2。

口径（印在每帧上，不只写 README）：
  重放图：产品 overlay 自身渲染 + 实测逐帧内容；不是录像（中间态 66–112ms vs 截图往返 ~30ms）。
"""
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else 'scripts/cross-kernel/out/replay'
DEST = sys.argv[2] if len(sys.argv) > 2 else 'docs/cross-kernel-shots/streaming-0.2.1-rc.2-replay.gif'
FONT = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
MIN_MS, MAX_MS = 260, 1600
rec = json.load(open(os.path.join(OUT, 'record.json')))
os.makedirs(os.path.dirname(DEST) or '.', exist_ok=True)
big = ImageFont.truetype(FONT, 26)
sm = ImageFont.truetype(FONT, 19)
CAP = '重放图：产品 overlay 自身渲染 + 实测逐帧内容（data-stream-frames 与留痕两源对齐）· 不是录像（中间态 66–112ms vs 截图往返 ~30ms）'

# 全局最大间隔，用来做比例映射
gaps = []
for r in [x for x in rec['rounds'] if x.get('ok')]:
    ts = [f['t'] for f in r['domFrames']]
    gaps += [ts[i] - ts[i - 1] for i in range(1, len(ts))]
biggest = max(gaps) if gaps else 1

cells = []
for r in [x for x in rec['rounds'] if x.get('ok')]:
    ts0 = r['domFrames'][0]['t']
    cells.append((os.path.join(OUT, 'r%d-00-blank.png' % r['round']), MIN_MS,
                  '轮%d 起点 · 产品 overlay 置空' % r['round'], 0))
    for i, f in enumerate(r['domFrames']):
        gap = f['t'] - ts0 if i == 0 else f['t'] - r['domFrames'][i - 1]['t']
        dur = MIN_MS if i == 0 else max(MIN_MS, min(MAX_MS, round(gap / biggest * MAX_MS)))
        png = next((s['png'] for s in r['shots'] if s.get('frame') == f['frame'] and s.get('chars') == f['chars']), None)
        if png is None:
            print('缺格', r['round'], f); continue
        tag = '终帧（权威）' if f['final'] else '增长步 %d' % (i + 1)
        cells.append((os.path.join(OUT, png), dur,
                      '轮%d %s  t=+%dms  %d 字符' % (r['round'], tag, f['t'] - ts0, f['chars']), f['chars']))

frames = []
durs = []
for path, dur, label, chars in cells:
    src = Image.open(path).convert('RGB')
    fr = Image.new('RGB', (src.size[0], src.size[1] + 96), (13, 17, 23))
    d = ImageDraw.Draw(fr)
    d.text((16, 8), label, font=big, fill=(255, 212, 121) if chars else (139, 152, 165))
    d.text((16, src.size[1] + 52), CAP, font=sm, fill=(110, 124, 138))
    fr.paste(src, (0, 44))
    frames.append(fr.convert('P', palette=Image.ADAPTIVE, colors=128))
    durs.append(int(dur))
last = frames[-1].convert('RGB')
ImageDraw.Draw(last).text((16, last.size[1] - 30), '↻ 循环到起点', font=sm, fill=(110, 124, 138))
frames.append(last.convert('P', palette=Image.ADAPTIVE, colors=128))
durs.append(700)
json.dump({'plan': [{'png': p, 'durMs': d, 'label': l} for p, d, l, _ in cells] + [{'png': 'loop', 'durMs': 700, 'label': '循环帧'}]},
          open(os.path.join(OUT, 'gif-plan.json'), 'w'), ensure_ascii=False, indent=1)
frames[0].save(DEST, save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=False, disposal=2)
print('GIF →', DEST, os.path.getsize(DEST), 'B  帧数 =', len(frames))
print('目标时长(ms) =', durs)
print('复跑命令：python3 scripts/cross-kernel/stream-replay-gif.py %s %s' % (OUT, DEST))
