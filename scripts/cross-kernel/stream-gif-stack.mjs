/**
 * 把"流式开"那一跑的真实帧 + "流式关"那一跑的整块到达，装配成**上下堆叠**的 GIF。
 *
 * ⚠️ 为什么是"上下"而不是任务书说的"左右并排同一时间轴"：
 *   开与关是**两次冷启动**（`streamingDelivery` 是 volatile 设置项，改它必须重启实例），
 *   而 `performance.now()` 每次页面加载都从 0 起算 ⇒ 两次运行的 t=0 **没有对应关系**。
 *   把它们画在同一条横轴上要成立，必须把两跑都锚到同一个宿主 epoch 时钟上，
 *   而"提交 → 首帧"这段（实测 7–25 秒）由**模型耗时**主导、方差远大于要展示的 60–90ms ⇒
 *   那才真会把人糊弄。所以这里：每格标自己的真实时刻，播放轴固定 1.5s 并写明名义慢放。
 * 左右同一时间轴的版本要等"一次运行内同时拿到两路"（同一 t0）才能做，见报告里的未判定。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const GEN = opt('gen', '?');
const ONDIR = opt('on', '');
const OFFDIR = opt('off', '');
const OUT = opt('out', '');
const HOSTLOG = opt('log', '');
// --nostream：这一代次拿不到开流边沿（#111）。右格据此标"未启用流式"，
// 既不写成 bug 也不写成"不支持" —— 它就是 #111 描述的那个静默无帧。
const NOSTREAM = argv.includes('--nostream');
if (ONDIR === '' || OUT === '') throw new Error('需要 --on 与 --out');

const readFrames = (dir) => {
  const j = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
  const pngs = readdirSync(dir).filter((n) => n.startsWith('r') && n.endsWith('.png'));
  return (j.rounds ?? []).map((r) => {
    const frames = (r.streamConsoleLines ?? []).map((l) => {
      const m = String(l).match(/stream frame=(\d+) final=(\d) chars=(\d+) turn=(\d+) t=(\d+)/);
      return m === null ? null : { frame: Number(m[1]), final: m[2] === '1', chars: Number(m[3]), t: Number(m[5]) };
    }).filter(Boolean);
    // ⚠️ **回退到页内 burst 事件**（0.1.2 就是这一支）：那代次拿不到开流边沿 ⇒
    //   根本不会有 "stream frame" 留痕，但这不代表"没东西可画"——
    //   burst 抓到的是**整块到达**这一件事，正是 #111 要展示的形状。
    //   回退时时刻来源换成 burst 自己的页内 tPage，并在格子上写明来源，不冒充逐帧。
    const shots = r.frames ?? [];
    const effective = frames.length > 0 ? frames : shots.map((s, i) => ({
      frame: i + 1, final: i === shots.length - 1, chars: s.chars, t: s.tPage, source: 'burst',
    }));
    return {
      round: r.round,
      shots,
      frames: effective,
      fromBurst: frames.length === 0 && shots.length > 0,
      unused: pngs.filter((n) => n.startsWith(`r${r.round}-`)),
    };
  });
};
const onRounds = readFrames(ONDIR);
const offRounds = OFFDIR === '' ? [] : readFrames(OFFDIR);

// 宿主侧"权威整块落地"的写次数：一次生成对应一次 _push（终帧那次，硬约束 2）
const hostLines = HOSTLOG !== '' && existsSync(HOSTLOG) ? readFileSync(HOSTLOG, 'utf8') : '';
const pushOf = (round) => {
  const m = [...hostLines.matchAll(/push landed rev=(\d+) bytes=(\d+) writeMs=(\d+)/g)];
  const hit = m[round - 1];
  return hit == null ? null : { rev: Number(hit[1]), bytes: Number(hit[2]), writeMs: Number(hit[3]) };
};

const W = 660;
const H = 210;      // composer 截图区
const CAP = 92;    // 标题 + 说明
const cell = (src, cap, sub, head) => {
  const out = join(ONDIR, `asm-${Math.random().toString(36).slice(2, 8)}.png`);
  const top = src != null && existsSync(src) ? [src, '-resize', `${W}x${H}`] : ['-size', `${W}x${H}`, 'xc:#0d1117'];
  const r = spawnSync('convert', [...top, '-background', '#0d1117', '-gravity', 'north',
    '-extent', `${W}x${H + CAP}`,
    '-fill', '#e6edf3', '-pointsize', '17', '-annotate', '+0+6', cap,
    '-fill', sub.startsWith('⚠') ? '#ff9ec4' : '#8b98a5', '-pointsize', '14', '-annotate', '+0+32', sub,
    '-fill', '#6e7f8d', '-pointsize', '12', '-annotate', '+0+58', head,
    out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('convert 失败：' + (r.stderr ?? '').split('\n')[0]);
  return out;
};

const nominalLead = 1500;   // 每轮播放轴（ms），真实提前量烧在格子上
const inputs = [];
const report = [];
for (const [i, r] of onRounds.entries()) {
  if (r.frames.length === 0) { report.push({ round: r.round, usable: false }); continue; }
  const t0 = r.frames[0].t;
  const lead = r.frames.at(-1).t - t0;
  // ⚠️ **可看见的增长步 ≠ 帧数**：限频窗口 60ms、且**终帧不受限频**，
  // 所以终帧常常只是"同一个前缀再送一次"（实测轮 2：12 字符 → 36ms 后 12 字符的终帧）
  // ⇒ 那一帧**没有任何新字符**，把它做成一格就是骗"逐字增长"。这里只保留
  //    字符数确实变多的帧作为"增长步"，其余轮如实标"无中间帧"。
  const visible = r.frames.filter((f) => !f.final || f.chars > (r.frames[r.frames.indexOf(f) - 1]?.chars ?? -1));
  const usable = visible.filter((f) => f.chars > 0);
  if (usable.length === 0) {
    report.push({ round: r.round, usable: false, why: '本轮没有可见增长步（终帧未带来新字符）',
      frames: r.frames.map((f) => ({ t: f.t - t0, chars: f.chars, final: f.final })) });
    continue;
  }
  const last = r.frames.at(-1);
  const offName = NOSTREAM ? null : (offRounds[i]?.unused?.[0] ?? null);
  const offShot = OFFDIR !== '' && offName != null ? join(OFFDIR, offName) : null;
  // 左右两块：左 = 流式第 k 帧；右 = 同轮"关流时用户看到的"（整块，一次到齐）
  // ⚠️ 语义按代次分岔，别混着报：
  //  - 有逐帧留痕（0.2.1 / 0.1.7）⇒ 这一列叫**提前量**（首帧→终帧）。
  //  - 没有帧、只有 burst 的整块出现（0.1.2，即 #111 那一支）⇒ 这一列叫**整块出现延迟**，
  //    它是"提交→回合完成"（实测 5.4~6.9 秒，由模型主导），**跟流式无关**。
  //    上一版把它印成"真实提前量 6852ms / 名义慢放 0×" —— 那是把回合时长冒充提前量，
  //    正是本任务第一条要求（诚实性）要防的事。
  const wholeBlockOnly = NOSTREAM || r.fromBurst;
  for (const [k, f] of usable.entries()) {
    const rel = f.t - t0;
    const left = cell(r.unused[0] ? join(ONDIR, r.unused[0]) : null,
      wholeBlockOnly
        ? `整块一次到齐   t=+${Math.round(rel)}ms（页内 performance.now()，含回合时长）`
        : `流式开 · 第 ${k + 1}/${usable.length} 个可见增长步   t=+${rel}ms（页内 performance.now()）`,
      `此刻 composer 里已有的建议字符 = ${f.chars}`,
      `GEN ${GEN} · 轮 ${r.round} · 帧号 ${f.frame} · final=${f.final ? 'true' : 'false'} · 播放轴 ${nominalLead}ms`);
    const right = cell(offShot,
      NOSTREAM ? '未启用流式（该代次拿不到 running 边沿，见 #111）'
        : (offShot == null ? '流式关 · 本次未录（占位，不代表"没差别"）' : '流式关 · 整块一次到齐'),
      NOSTREAM ? `宿主 streaming=1 ready=1 on=1 但 subs=0 ⇒ 只有这一次整块到齐（${last.chars} 字符）`
        : (offShot == null ? '—' : `关流时一次给到 ${last.chars} 字符，中间没有可展示的时刻`),
      NOSTREAM ? '不是 bug、也不是"不支持"：这一代次客户端从没拿到那枚边沿（#111 机制未证）'
        : '同一提示词、同一构建、同代次；两次冷启动 ⇒ 右格不与其对齐同一条横轴（见脚本头）');
    const stacked = join(ONDIR, `stack-r${r.round}-${k + 1}.png`);
    const sp = spawnSync('convert', [left, right, '-background', '#0d1117', '-append', stacked], { encoding: 'utf8' });
    if (sp.status !== 0) throw new Error('append 失败');
    inputs.push({ file: stacked, ms: k === 0 ? 420 : Math.round(nominalLead / usable.length) });
  }
  const p = pushOf(r.round);
  report.push({ round: r.round, usable: true, kind: wholeBlockOnly ? 'whole-block' : 'streamed',
    frames: r.frames.map((f) => ({ t: f.t - t0, chars: f.chars, final: f.final })),
    visibleSteps: usable.map((f) => ({ t: f.t - t0, chars: f.chars })),
    leadMs: wholeBlockOnly ? null : r.frames.at(-1).t - t0,
    wholeBlockAppearMs: wholeBlockOnly ? Math.round(r.frames.at(-1).t - t0) : null,
    authoritativePush: p });
}
// 只有"确实有逐帧留痕"的轮次参与提前量统计；整块那几轮单独报出现延迟，不混进中位数。
const streamedRounds = report.filter((x) => x.usable && x.kind === 'streamed');
const leads = streamedRounds.map((x) => x.leadMs).sort((a, b) => a - b);
const med = leads.length ? leads[Math.floor(leads.length / 2)] : null;
mkdirSync(join(ONDIR, 'asm'), { recursive: true });
const listFile = join(ONDIR, 'frames.txt');
const abs = (p) => (p.startsWith('/') ? p : `${process.cwd()}/${p}`);
writeFileSync(listFile, inputs.map((x) => `file '${abs(x.file)}'\nduration ${(x.ms / 1000).toFixed(3)}`).join('\n') + '\n');
const fr = spawnSync('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
  '-vf', 'fps=10,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', OUT], { encoding: 'utf8' });
if (fr.status !== 0) { console.log((fr.stderr ?? '').split('\n').slice(-5).join('\n')); process.exit(1); }
writeFileSync(join(ONDIR, 'report.json'), JSON.stringify({ gen: GEN, nominalLead, leadsMs: leads, med, report }, null, 2) + '\n');
console.log(`GIF → ${OUT}（${statSync(OUT).size} B）`);
console.log('流式轮次=' + streamedRounds.length + '，整块轮次=' + report.filter((x) => x.usable && x.kind === 'whole-block').length);
console.log(`真实提前量：${JSON.stringify(leads)}ms，中位 ${med ?? '—'}ms；播放轴 ${nominalLead}ms`
  + (med == null ? '（本轮没有流式轮次 ⇒ 不宣称任何提前量/慢放倍数）'
    : ` ⇒ 名义慢放约 ${Math.round(nominalLead / Math.max(med, 1))}×`));
console.log('命令：ffmpeg -y -f concat -safe 0 -i ' + listFile + " -vf 'fps=10,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse' " + OUT);
