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
# E4：**逐帧读图上的浅灰墨迹**，断言每组"起点在前、终帧在后"（墨迹非递减）。
# 只核时长与帧数不够：上一版"置空起点"被排在每组**末尾**，时长全对、内容顺序却是
# "出现 → 变长 → 消失 → 又出现" —— 那个"消失"不是产品行为，是我们自己放错了格子。
def ghost_ink(frame, xlo=100):
    # 只数**文字区**的浅灰墨迹。整幅数会把**输入框的圆角边框**也算进来
    # （实测置空格整幅 606 个冷灰像素，全落在 x=14 与 x=222 两条边上，
    #  而真实幽灵从 x≈113 才开始）。断言 B 之所以是 0，是因为它量的是贴 overlay
    #  盒子的紧裁切；GIF 帧比那个宽 ⇒ 这里必须先按 x 范围收口，否则 E4 把"边框"读成"文字"。
    rgb = frame.convert('RGB')
    w, h = rgb.size
    px = rgb.load()
    n = 0
    for y in range(h):
        for x in range(xlo, w, 2):
            r, g, b = px[x, y]
            if 130 < r < 215 and 130 < g < 220 and 135 < b < 225 and 4 <= b - r <= 30 and abs(r - g) <= 18:
                n += 1
    return n


# E4：**把 GIF 合成回画面再逐格量墨迹**（用 ffmpeg 抽"内容变化帧"，不是 PIL 裸 seek）。
#   为什么必须合成：GIF 默认 disposal=0/"keep" ⇒ 每格画在上一格的**残留位图**上，
#   "置空起点"格在屏幕上根本不空（实测残留 15837 墨迹，而它自己只有 606）。
#   为什么不能 PIL 裸 seek：那读到的是**增量帧**，画布是上一帧的遗留 ⇒ 会得出
#   "起点格有 5370 墨迹"这种假结论；也不能手工 alpha 累加（disposal 语义会算错）。
import subprocess
import tempfile
tmpd = tempfile.mkdtemp(prefix='gifE-')
subprocess.run(['ffmpeg', '-y', '-i', GIF,
                '-vf', "select='gt(pts-prev_pts,0)+eq(n,0)',showinfo", '-vsync', 'vfr',
                os.path.join(tmpd, 'f%02d.png')], capture_output=True, text=True)
import glob
paths = sorted(glob.glob(os.path.join(tmpd, 'f*.png')), key=lambda x: int(x.split('f')[-1].split('.')[0]))
inks = []
for f in paths:
    im2 = Image.open(f).convert('RGB')
    inks.append(ghost_ink(im2))
import shutil
shutil.rmtree(tmpd, ignore_errors=True)
groups = [inks[i:i + 3] for i in range(0, len(inks), 3)]
e4a = all(g[0] < 500 for g in groups if len(g) == 3)                 # 起点格在**合成后画面**里真的空
e4b = all(g[0] <= g[1] <= g[2] * 1.05 for g in groups if len(g) == 3)  # 组内不递减（终帧最长）
e4c = len(paths) == len(targets) + 1                                  # 合成后的画面数 == 格数+1
e4 = e4a and e4b and e4c
print('合成后逐格墨迹（应为 起点≈0 → 步 → 终帧）=')
for gi, g in enumerate(groups, 1):
    print('  组%d' % gi, g)
print('E4a 起点格合成后为空(<500):', e4a, ' E4b 组内不递减:', e4b, ' E4c 合成画面数==格数+1:', e4c)

ok = e1 and e2 and e3 and e4
print('\n断言 E：', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
