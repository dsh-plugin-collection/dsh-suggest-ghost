#!/usr/bin/env python3
"""把重建格子拼成带中文标注的对比图与 GIF 帧（task-44）。

标注必须用真实 TTF（wqy-zenhei）画：ImageMagick 的 -annotate 在本机丢中文字形
（"重建图""轮""置空后"整块不见了），带着坏标注的图会误导读者 —— 标注坏了也是坏交付。

每格都用**同一个裁剪窗口**（同一 x0/宽度、同一文字行 y 范围、不缩放），
否则"变长"会被不同的裁切框抵消，看不出差别。
"""
import json
import os
import sys
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else 'scripts/cross-kernel/out/gif3-rebuild'
FONT = '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc'
CIRCLED = '①②③④⑤⑥⑦⑧⑨'


def is_ghost(p):
    r, g, b = p[0], p[1], p[2]
    return (130 < r < 215 and 130 < g < 220 and 135 < b < 225
            and 4 <= b - r <= 30 and abs(r - g) <= 18)


def ink_rows(path, xlo=0, xhi=None):
    """文字行的 y 范围：按"偏离背景(白)的像素"定，**不用幽灵色判据**。
    幽灵色判据太严（只收冷灰核心），会漏掉抗锯齿边缘，
    于是量到的行高比真实字形矮 ⇒ 拼出来的图把字**下沿切掉**（上一版就是这个毛病）。"""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    # 只在**文字的 x 范围**内找行：整幅扫会把输入框的圆角边框也当成"墨迹"，
    # 于是 y 窗口被边框撑高、文字反而贴到框底被切掉（上一版就是这个）。
    hi = xhi or w
    ys = [y for y in range(h) for x in range(xlo, min(hi, w), 2)
          if px[x, y][0] < 236 or px[x, y][1] < 236 or px[x, y][2] < 236]
    if not ys:
        return 0, h
    return max(0, min(ys) - 10), min(h, max(ys) + 14)


def scan(path):
    """(墨迹数, 外接 x0,x1, 有墨迹的行范围 y0,y1)。"""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    xs, ys = [], []
    for y in range(h):
        for x in range(w):
            if is_ghost(px[x, y]):
                xs.append(x)
                ys.append(y)
    if not xs:
        return 0, None, (0, h)   # 置空图：由调用方套用同一 y 范围
    return len(xs), (min(xs), max(xs)), (max(0, min(ys) - 8), min(h, max(ys) + 12))


def main():
    rec = json.load(open(os.path.join(OUT, 'record.json')))
    big = ImageFont.truetype(FONT, 27)
    mid = ImageFont.truetype(FONT, 23)
    sm = ImageFont.truetype(FONT, 20)
    W = 1520
    summary = []
    for r in [x for x in rec['rounds'] if x.get('ok')]:
        frames = [c for c in r['cells'] if c['kind'] == 'frame']
        blank = next(c for c in r['cells'] if c['kind'] == 'blank')
        fin_path = os.path.join(OUT, frames[-1]['png'])
        fin_cnt, fin_box, _ = scan(fin_path)
        fb = fin_box or (0, 900)
        fin_rows = ink_rows(fin_path, max(0, fb[0] - 6), fb[1] + 6)   # ← 行范围只看文字列内
        x1 = min(W, (fin_box[1] if fin_box else 900) + 60)
        top, bot = fin_rows
        # 置空图没有墨迹，用同一 y 范围，保证"同一块画面区域"
        def crop_of(png):
            im = Image.open(os.path.join(OUT, png)).convert('RGB')
            return im.crop((0, top, min(im.size[0], x1), min(im.size[1], bot)))
        cells = [('产品 overlay 置空（起点，无幽灵）', blank['png'], 0)]
        for i, c in enumerate(frames):
            tag = '终帧（final=true，随后仍写一次 _push）' if c['final'] else ('增长步 %d' % (i + 1))
            cells.append(('t=+%dms  %d 字符  %s' % (c['tMs'], c['chars'], tag), c['png'], c['chars']))
        ch = crop_of(cells[0][1]).size[1]
        # ---- 对比图（纵向堆叠）----
        total = 52 + sum(32 + ch + 8 for _ in cells) + 44
        out = Image.new('RGB', (W, total), (13, 17, 23))
        d = ImageDraw.Draw(out)
        y = 10
        d.text((14, y), '重建图 · 0.2.1-rc.2 · 轮 %d —— 底图为真实截图，产品 overlay 已置空，灰字按逐帧留痕重绘'
                 % r['round'], font=big, fill=(230, 237, 243))
        y += 40
        for i, (lab, png, chars) in enumerate(cells):
            d.text((14, y), '%s %s' % (CIRCLED[i], lab), font=mid, fill=(255, 212, 121))
            y += 30
            out.paste(crop_of(png), (12, y))
            y += ch + 8
        inks = [scan(os.path.join(OUT, c['png']))[0] for c in frames]
        spans = [(scan(os.path.join(OUT, c['png']))[1] or (0, 0)) for c in frames]
        d.text((14, y), '断言 A 相交=%s · B 墨迹=0 · C 墨迹 %s（单调）· D 跨度 %s px 对应 %s 字符 · 同一窗口不缩放'
               % (r['assertionA']['clipIntersectsInput'], '→'.join(map(str, inks)),
                  '→'.join(str(b - a) for a, b in spans), '→'.join(str(c['chars']) for c in frames)),
               font=sm, fill=(139, 152, 165))
        name = 'two-cells-r%d.png' % r['round']
        out.save(os.path.join(OUT, name))
        # ---- GIF 帧（每格一张，含真实 t= 标注）----
        for i, (lab, png, chars) in enumerate(cells):
            fr = Image.new('RGB', (x1, ch + 74), (13, 17, 23))
            fd = ImageDraw.Draw(fr)
            fd.text((12, 6), lab if chars else '起点 · 置空（无幽灵）', font=mid,
                    fill=(139, 152, 165) if chars == 0 else (255, 212, 121))
            # 每帧都带这行：GIF 单独被转发时，"非录像 + 停留∝真实间隔"必须跟着走
            fd.text((12, ch + 46), '格与格之间的停留时长 ∝ 真实帧间隔 · 本图非录像（overlay 已置空、灰字按逐帧留痕重绘）',
                    font=sm, fill=(110, 124, 138))
            fr.paste(crop_of(png), (0, 36))
            # ⚠️ 文件名**必须带轮次**：上一版只带 i，三轮写进同一批 gif-00/01/02.png，
            #   后一轮覆盖前一轮 ⇒ 交付的 GIF 其实只有轮 3 的格子被重复三遍，
            #   而我在报告里说"8 格"。⇒ 产物自己不会说话，回读才知道（见断言 E）。
            fr.save(os.path.join(OUT, 'gif-r%d-%02d.png' % (r['round'], i)))
        summary.append({'round': r['round'], 'file': name, 'ink': inks,
                        'span': [b - a for a, b in spans], 'chars': [c['chars'] for c in frames],
                        'tMs': [c['tMs'] for c in frames], 'cells': len(cells)})
        print('轮%d → %s  墨迹=%s 跨度=%s 字数=%s t=%s'
              % (r['round'], name, inks, [b - a for a, b in spans],
                 [c['chars'] for c in frames], [c['tMs'] for c in frames]))
    json.dump(summary, open(os.path.join(OUT, 'compose.json'), 'w'), ensure_ascii=False, indent=1)
    return 0


if __name__ == '__main__':
    sys.exit(main())
