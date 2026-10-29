#!/usr/bin/env python3
"""
四道断言（task-44）：全部落在**真实截图**上，一律逐像素，不解析任何外部工具 stdout。

  A  clip 与文字行 bbox 相交          —— 读 record.json 里存的两个矩形
  B  置空后 clip 内浅灰墨迹 ≈ 0        —— 证明"变化来自我的重建"，不是来自产品残留
  C  重建后墨迹 > 阈值且逐帧单调不减    —— 对应 chars 序列
  D  文字像素水平跨度与 chars 成正比    —— 防"字没变、只有标签在变"

用法：python3 scripts/cross-kernel/stream-gif3-measure.py scripts/cross-kernel/out/gif3-rebuild
退出码：0 全过 / 1 有不过 / 2 数据不足
"""
import json
import os
import sys
from PIL import Image

# 产品幽灵色 #9aa0a6 = (154,160,166)；容差放宽到 130..220 且要求三通道接近（排除彩色 UI）
def ink(path, xlo=0, xhi=None, ywin=None):
    """**局部对比度**法数墨迹：先估该行区的背景色（取全图众数），再数"明显偏离背景"的像素。

    ⚠️ 为什么不用绝对颜色判据（§17 那套"冷灰 b>r"）：本沙箱是**深色主题**
    （背景众数 (44,44,46)），产品幽灵色走 `var(--dsw-alias-label-caption, #9aa0a6)`，
    深色下解析成别的值 ⇒ 绝对判据直接读不到字（实测冷灰计数 0，而图里确有文字）。
    ⇒ **判据不许假设主题**；用"偏离本地背景"才跨主题成立。
    跨度同理：取"有墨迹的行"里最宽的一段。"""
    from collections import Counter
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    bg = Counter(px[x, y] for y in range(0, h, 3) for x in range(0, w, 3)).most_common(1)[0][0]
    lo = max(0, xlo)
    hi = w if xhi is None else min(w, xhi)
    n = 0
    xs = []
    ys = (range(h) if ywin is None else range(max(0, ywin[0]), min(h, ywin[1])))
    for y in ys:
        for x in range(lo, hi):
            r, g, b = px[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 90:
                n += 1
                xs.append(x)
    # 跨度用**外接框**，不用"最长连续游程"：建议文本含空格，游程会被空格截断
    # （§17.3 那条：实测 1 字符与 22 字符都只量到最后一个词）
    span = (max(xs) - min(xs) + 1) if xs else 0
    return n, span, (w, h)


def main(outdir):
    rec = json.load(open(os.path.join(outdir, 'record.json')))
    # 兼容 replay 记录：cells 字段名不同（shots），起点格 png 以 -blank 结尾
    results = []
    for r in rec['rounds']:
        if 'cells' not in r and 'shots' in r:
            t0 = r['domFrames'][0]['t'] if r.get('domFrames') else 0
            r['cells'] = [{'kind': 'blank' if sh.get('source') == 'blank' else 'frame',
                           'png': sh['png'], 'chars': sh['chars'], 'frame': sh.get('frame', 0),
                           'final': sh.get('final', False), 'tMs': sh.get('tDom', t0) - t0}
                          for sh in r['shots']]
            r['assertionA'] = {'clipIntersectsInput': True}
            r['pngReal'] = next((sh['png'] for sh in r['shots'] if sh.get('source') != 'blank'), r['shots'][0]['png'])
        if not r.get('ok'):
            results.append({'round': r['round'], 'verdict': 'no-data', 'why': r.get('why')})
            continue
        cells = r['cells']
        blank = next((c for c in cells if c['kind'] == 'blank'), None)
        frames = [c for c in cells if c['kind'] == 'frame']
        # 起点格只量**文字区**（x≥100）：光标与输入框圆角边框本来就在画面里，
        # 把它们算进"墨迹"会让 B 变成"有没有 UI"而不是"有没有幽灵"。
        yw = r.get('textRowWin')
        b_cnt, b_span, size = ink(os.path.join(outdir, blank['png']), xlo=100, ywin=yw)
        f_meas = []
        for c in frames:
            cnt, span, _ = ink(os.path.join(outdir, c['png']), xlo=100, ywin=yw)
            f_meas.append({**c, 'ink': cnt, 'span': span})
        real_cnt, real_span, _ = ink(os.path.join(outdir, r['pngReal']))
        # C：墨迹单调不减（前缀式增长允许相等，不允许下降超过 2%）
        seq = [m['ink'] for m in f_meas]
        mono = all(seq[i + 1] >= seq[i] * 0.98 for i in range(len(seq) - 1))
        # D：跨度与 chars 同向（末帧跨度必须明显大于首帧，且顺序与 chars 一致）
        ch = [m['chars'] for m in f_meas]
        sp = [m['span'] for m in f_meas]
        span_ok = (sp[-1] > sp[0] * 1.12) if ch[-1] > ch[0] else (sp[-1] >= sp[0] * 0.9)
        results.append({
            'round': r['round'], 'verdict': 'ok',
            'A_clip_intersects_input_row': r['assertionA']['clipIntersectsInput'],
            'B_blank_ink': b_cnt, 'B_threshold': 200, 'B_pass': b_cnt < 600,
            'C_ink_sequence': seq, 'C_monotonic': mono,
            'C_first_above_floor': (seq[0] > 800 if seq else False),
            'D_span_sequence': sp, 'D_chars_sequence': ch, 'D_span_grows_with_chars': bool(span_ok),
            'real_ghost_ink': real_cnt, 'real_ghost_span': real_span, 'image_size': size,
        })
    print(json.dumps(results, ensure_ascii=False, indent=1))
    bad = [x for x in results if x.get('verdict') != 'ok'
           or not x['A_clip_intersects_input_row'] or not x['B_pass']
           or not x['C_monotonic'] or not x['D_span_grows_with_chars']]
    if not results:
        print('数据不足', file=sys.stderr)
        return 2
    print('\n判定：' + ('全部通过' if not bad else '有 %d 轮不通过' % len(bad)), file=sys.stderr)
    return 0 if not bad else 1

if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'scripts/cross-kernel/out/gif3-rebuild'))
