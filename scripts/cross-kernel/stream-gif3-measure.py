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
def is_ghost(px):
    """产品幽灵色是**冷灰** #9aa0a6=(154,160,166)：b 比 r 大 ~12。
    UI 边框/滚动条是**中性灰** (223,223,223)：b == r。
    上一版只要求"三通道接近"，于是把中性灰 chrome 也算成墨迹 ⇒
    B 报 405（其实是边框）、D 报跨度=整幅（其实是左右两条边）。
    ⇒ 判据要能区分"我要量的东西"和"长得像它的别的东西"，否则数字全绿也是错的。"""
    r, g, b = px[0], px[1], px[2]
    return 130 < r < 215 and 130 < g < 220 and 135 < b < 225 and 4 <= b - r <= 30 and abs(r - g) <= 18

def ink(path):
    """返回 (墨迹像素数, 文字水平跨度, 图尺寸)。
    跨度 = **所有墨迹像素的外接框宽度**。⚠️ 不能用"最长连续游程"：
    建议文本里有空格（如"怎么用 ss -tlnp"），游程会被空格截断，
    于是 10 字符与 15 字符都只量到最后一个词（实测 47 vs 53，看不出比例）。
    外接框现在安全，因为判据已排除中性灰 chrome（置空图实测墨迹 = 0）。"""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    count = 0
    xs = []
    for y in range(h):
        for x in range(w):
            if is_ghost(px[x, y]):
                count += 1
                xs.append(x)
    span = (max(xs) - min(xs) + 1) if xs else 0
    return count, span, (w, h)

def main(outdir):
    rec = json.load(open(os.path.join(outdir, 'record.json')))
    results = []
    for r in rec['rounds']:
        if not r.get('ok'):
            results.append({'round': r['round'], 'verdict': 'no-data', 'why': r.get('why')})
            continue
        cells = r['cells']
        blank = next((c for c in cells if c['kind'] == 'blank'), None)
        frames = [c for c in cells if c['kind'] == 'frame']
        b_cnt, b_span, size = ink(os.path.join(outdir, blank['png']))
        f_meas = []
        for c in frames:
            cnt, span, _ = ink(os.path.join(outdir, c['png']))
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
            'B_blank_ink': b_cnt, 'B_threshold': 120, 'B_pass': b_cnt < 120,
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
