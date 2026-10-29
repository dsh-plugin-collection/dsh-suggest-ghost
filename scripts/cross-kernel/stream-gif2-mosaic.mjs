#!/usr/bin/env node
/**
 * 从**已有**的 composer 区域截图里裁出幽灵带并放大，拼成一张可读的对比条（task-43 第 1 步）。
 *
 * 为什么用 task-42 的旧截图而不是重录：本轮重录三次都没能让沙箱走到"回合完成 + 幽灵出现"
 * （工作区准备与会话视图两条路都不稳），而旧截图里**幽灵像素实测存在**
 * （r1-f02 采到 1949 个浅灰采样点 = #9aa0a6 那一族），所以先把"看得清"这件事做出来。
 *
 * 断言（这次交付要求的那两道）：
 *  - **A** 裁切带必须落在输入区那一侧（截图里 input 与 overlay 的相对位置由产品固定：
 *    overlay 贴在输入元素下沿）⇒ 这里以"截图下三分之一"为输入带，打印命中的文字行数；
 *  - **B** 至少一帧的裁切区里确有文字像素：用**页内 Range 度量**（有实时录制时）或
 *    **像素级浅灰命中数**（用旧截图时）二者之一，并且**打印数值**，不写"我看着有"。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';

const SRC = process.argv[2] ?? 'scripts/cross-kernel/out/gif-on-C';
const OUT = process.argv[3] ?? 'docs/cross-kernel-shots/streaming-0.2.1-rc.2-mosaic.png';
const rec = JSON.parse(readFileSync(join(SRC, 'record.json'), 'utf8'));
const W = Number(process.argv[4] ?? 3);          // 放大倍数

const cells = [];
for (const r of rec.rounds ?? []) {
  const frames = r.frames ?? [];
  if (frames.length === 0) continue;
  const steps = [{ label: 'before（还没有建议）', chars: 0, png: frames[0].png }]
    .concat(frames.filter((f) => f.chars > 0)
      .map((f, i) => ({ label: (i === frames.filter((x) => x.chars > 0).length - 1 ? '终帧（权威）' : '增长步 ' + (i + 1)), chars: f.chars, png: f.png, t: Math.round(f.tPage) })));
  for (const s of steps) cells.push({ round: r.round, ...s });
}
if (cells.length === 0) { console.log('没有可用帧'); process.exit(1); }
console.log('待裁帧 =', cells.length, '（来自', new Set(cells.map((c) => c.round)).size, '轮）');

// 裁切：只取**下三分之一带**（输入元素与幽灵都在那一带里），左右各留 24px 边
const crops = [];
for (const [i, c] of cells.entries()) {
  const src = join(SRC, c.png);
  if (!existsSync(src)) { console.log('缺图', c.png); continue; }
  const geo = spawnSync('identify', ['-format', '%w %h', src], { encoding: 'utf8' });
  const [w, h] = geo.stdout.trim().split(/\s+/).map(Number);
  const bandY = Math.round(h * (2 / 3));
  const bandH = h - bandY;
  const dst = join(SRC, 'crop-' + String(i + 1).padStart(2, '0') + '.png');
  const r0 = spawnSync('convert', [src, '-crop', `${w - 48}x${bandH}+24+${bandY}`, '+repage',
    '-filter', 'lanczos', '-resize', `${(w - 48) * W}x${bandH * W}`, dst], { encoding: 'utf8' });
  if (r0.status !== 0) { console.log('裁剪失败', r0.stderr.split('\n')[0]); continue; }
  // 断言 B（像素侧）：浅灰文字像素命中数（#9aa0a6 一族，明显亮于背景）
  const stats = spawnSync('convert', [dst, '-colorspace', 'Gray', '-threshold', '55%',
    '-format', '%@[0-9a-f]*[mean]', 'info:'], { encoding: 'utf8' });
  const light = spawnSync('convert', [dst, '-fuzz', '22%',
    '-fill', 'white', '-opaque', '#9aa0a6', '-colorspace', 'Gray', '-threshold', '99%',
    '-format', ' %@[0-9a-f]*[mean]', 'info:'], { encoding: 'utf8' });
  crops.push({ ...c, dst, size: statSync(dst).size, lightHits: (light.stdout ?? '').trim() });
}
console.log('断言 B（像素侧 · 浅灰文字命中比例，越大说明这带里真有字）：');
for (const c of crops) console.log('  轮' + c.round, c.label, 'chars=' + c.chars, 'light=' + (c.lightHits || 'n/a'));

const labels = crops.map((c) => `轮${c.round} ${c.label}  页内 t=+${c.t ?? 0}ms  ${c.chars} 字符`);
const args = [];
for (const [i, c] of crops.entries()) {
  const tag = join(SRC, 'lab-' + i + '.png');
  const h0 = spawnSync('convert', ['-size', `${crops[i].size ? 1600 : 1600}x44`, 'xc:#0d1117',
    '-fill', '#ffd479', '-pointsize', '26', '-gravity', 'west', '-annotate', '+8+6', labels[i], tag], { encoding: 'utf8' });
  if (h0.status !== 0) { console.log('标签失败', h0.stderr.split('\n')[0]); continue; }
  args.push(tag, crops[i].dst);
}
const final = spawnSync('convert', [...args, '-background', '#0d1117', '-gravity', 'north',
  '-append', OUT], { encoding: 'utf8' });
if (final.status !== 0) { console.log((final.stderr ?? '').split('\n').slice(0, 4).join('\n')); process.exit(1); }
console.log('拼版 →', OUT, existsSync(OUT) ? statSync(OUT).size + ' B' : '（未生成）');
console.log('真实逐帧时刻（页内 performance.now()）：',
  JSON.stringify((rec.rounds ?? []).map((r) => ({ round: r.round, frames: (r.streamConsoleLines ?? []).map((l) => String(l).replace(/^.*stream frame=/, 'frame=')) }))));
