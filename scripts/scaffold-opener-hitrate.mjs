#!/usr/bin/env node
/**
 * 一次性离线量度（**故意不接 `test:smoke` 链** —— 它读真实用户日志、非确定性、耗时分钟级，
 * 同 `hot-window-staleness.mjs` 的处置：进链等于给门禁加"依赖某台机器上有哪些会话"的负担）。
 *
 * 它回答 Gitea #124 的 P0 问题：**零 token 起稿路（拿"别的会话的第一句"当空草稿起稿候选）
 * 值不值得做**。判据是命中率，不是"看起来能用"。七组数字：
 *   1 数据可得性   本机 `~/.dsh/sessions/<工作区>/<会话>/session.v*.jsonl.zstd` 里能否离线
 *                  拿到每会话「第一句真人消息」序列（筛选口径 = 宿主 `userTextOfEvent`/环播种
 *                  同一份实现：`extractHistory`，归一化 = `normalizeForMatch`，不另写一套）。
 *   2 样本量       会话数（人开 / 机器开：origin=subagent 或 parentSession 非空）、真人消息数。
 *   3 top-1 命中率 按 createdAt 时间序、逐会话用「此前所有会话 opener 的频次表 top-1」预测它的
 *                  第一句（排除本会话自身贡献 = 模拟"新会话此刻还没有自己的历史"）。
 *   4 top-K 曲线   K=1/3/5/10 累积命中，给"候选做多宽"定数。
 *   5 跨项目污染率 被预测会话的 cwd 来自日志头（数据里有 ⇒ 可区分）；top-1 候选的全部支撑会话
 *                  都在**其它工作区**的占比；另给"按工作区分表"的对照命中率。
 *   6 环截断偏差   环容量 RING_CAPACITY(600)、推送窗口 HISTORY_PUSH_CAP(300)：环满会话占比、
 *                  首句掉出推送窗口/环的占比（"环首元素=第一句"这一前提还成立多少）。
 *   7 结论         PASS / FAIL / NOT-COVERED 三态 + 阈值与依据。
 *
 * 两个表变体（都要看，差距本身就是结论的一部分）：
 *   A 全量表：opener 表含机器开（subagent）会话 —— 这是"今天直接照『环首元素』实现"的真实
 *     形态，宿主的事件流不分人机。⇒ 作为**判据主数**。
 *   B 纯人表：opener 表只收人开会话 —— 需要新增"人机区分"才做得到的最好情况，作上限对照。
 * 命中口径三档：精确（norm 相等）/ 前缀（候选 norm 是真实首句 norm 的前缀，Tab 后用户接着打
 *   能续上）/ 任意向（互相前缀，含"建议比用户想打的长"）。主判据用 **前缀**。
 *
 * 阈值（先写在代码里再看数，防事后挑数）：
 *   T1  top-1 前缀命中 ≥ 20%   —— 空草稿幽灵对**每个**新会话都出现；<1/5 命中意味着 ≥80% 的
 *       开局展示的是与用户意图无关的灰字。本仓没有任何采纳率遥测（离线拿不到），所以这是
 *       **提案**而非实证定论；提案依据是下面打出来的两个对照：
 *       ① opener 新颖率上界（top-1 命中率的天花板，与排序技巧无关）；
 *       ② 同会话内后续消息重复率（现役历史补全在有真实可复用文本时的供给形态）。
 *   T10 top-10 前缀命中 ≥ 50%  —— 热度表 2000 条上限（#88）下候选宽度有上界，top-10 都兜不
 *       住一半就说明"放宽候选"救不了这条路，直接进 P1。
 *   样本下限 MIN_UNIVERSE=50：人开会话且能提出 opener 的样本不足 ⇒ **NOT-COVERED**（不许把
 *   小样本说成 FAIL/PASS）。
 *
 * 跑法：`node --experimental-strip-types scripts/scaffold-opener-hitrate.mjs [--sessions-root DIR] [--limit N]`
 *
 * 隐私（本仓硬规矩，同 completion-gate 的 `draftChars=` 口径）：**只读**用户数据；
 * 只打印聚合数字（计数/占比/长度分位数/工作区个数），**绝不打印任何用户正文、cwd、会话 id**。
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractHistory, normalizeForMatch, HISTORY_TEXT_MAX_CHARS } from '../src/client/history.ts';
import { HISTORY_PUSH_CAP, RING_CAPACITY } from '../src/coldstart.ts';

// —— 参数 ——
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const SESSIONS_ROOT = argOf('--sessions-root') ?? join(homedir(), '.dsh', 'sessions');
const LIMIT = Number(argOf('--limit') ?? 0); // 0 = 全量（>0 仅供冒烟调试，会显式标注）

// —— 判据常量（先看这里，再看数） ——
const THRESHOLD_TOP1_PREFIX = 0.20;
const THRESHOLD_TOP10_PREFIX = 0.50;
const MIN_UNIVERSE = 50;
const K_CURVE = [1, 3, 5, 10];

const pct = (hit, total) => (total === 0 ? '—(0 样本)' : `${((hit / total) * 100).toFixed(1)}%`);

// ============================================================================
// 采集：每个会话目录 → {id, createdAt, cwd, machine, texts[], openerNorm, ...}
// ============================================================================
/**
 * 解析一份会话日志。nodes 口径与 `scripts/replay-history.mjs` / `hot-window-staleness.mjs`
 * 相同：`extractHistory` 认 `kind`，日志事件认 `type`，直接把 user/message 事件包成
 * `{kind:'user', data}` 喂进去（source/system-reminder/超长筛选都在 extractHistory 里）。
 */
function parseSession(rawText) {
  let header = null;
  const nodes = [];
  let badLines = 0;
  // 「0 真人消息」原因计数器：口径逐项对齐 extractHistory 的跳过条件，
  // 让数据可得性一节能把「为什么提不出首句」报成数字而不是猜测。
  let umEvents = 0; // user/message 事件总数
  let umNonUser = 0; // source.kind 为非 'user' 字符串（宿主注入/agent 转写）
  let umTooLong = 0; // 合并文本 trim 后 > HISTORY_TEXT_MAX_CHARS（大粘贴/任务书）
  let umEmptyish = 0; // 空文本或以 <system-reminder> 开头
  let umValid = 0; // 能通过筛选（≥1 即应能提出首句）
  const umKinds = new Map(); // 非 user 的 source.kind 直方图（解释「提不出首句」的成因）
  for (const line of rawText.split('\n')) {
    if (line === '') continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (header === null && e.type === 'session') {
      header = e;
      continue;
    }
    if (e.type !== 'user/message') continue;
    umEvents++;
    nodes.push({ kind: 'user', data: e.data });
    const srcKind = e.data?.source?.kind;
    if (typeof srcKind === 'string' && srcKind !== 'user') {
      umNonUser++;
      umKinds.set(srcKind, (umKinds.get(srcKind) ?? 0) + 1);
      continue;
    }
    let text = '';
    if (Array.isArray(e.data?.content)) {
      for (const b of e.data.content) {
        if (b && b.type === 'text' && typeof b.text === 'string') text += b.text;
      }
    }
    text = text.trim();
    if (text === '' || text.startsWith('<system-reminder>')) umEmptyish++;
    else if (text.length > HISTORY_TEXT_MAX_CHARS) umTooLong++;
    else umValid++;
  }
  const texts = extractHistory(nodes);
  const origin = header && typeof header.origin === 'string' ? header.origin : '';
  const machine = origin === 'subagent' || (header != null && typeof header.parentSession === 'string');
  return {
    id: header?.id ?? null,
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : 0,
    cwd: typeof header?.cwd === 'string' ? header.cwd : '',
    machine,
    texts,
    badLines,
    um: { events: umEvents, nonUser: umNonUser, tooLong: umTooLong, emptyish: umEmptyish, valid: umValid, kinds: umKinds },
  };
}

function collect() {
  if (!existsSync(SESSIONS_ROOT)) {
    console.log(`NOT-COVERED：数据根目录不存在 ${SESSIONS_ROOT}`);
    process.exit(2);
  }
  const sessions = [];
  let wsDirs = 0;
  let sessionDirs = 0;
  let noLogFile = 0;
  let decodeFail = 0;
  let headerFail = 0;
  for (const ws of readdirSync(SESSIONS_ROOT)) {
    const wsPath = join(SESSIONS_ROOT, ws);
    try { if (!statSync(wsPath).isDirectory()) continue; } catch { continue; }
    wsDirs++;
    let sub;
    try { sub = readdirSync(wsPath); } catch { continue; }
    for (const sd of sub) {
      const sdPath = join(wsPath, sd);
      try { if (!statSync(sdPath).isDirectory()) continue; } catch { continue; }
      sessionDirs++;
      // 同目录多个版本日志时取版本号最大的（v4 是 v3 的超集，取旧的重算同一会话）。
      let logFiles;
      try {
        logFiles = readdirSync(sdPath)
          .filter((f) => /^session\.v\d+\.jsonl\.zstd$/.test(f))
          .sort((a, b) => Number(b.match(/v(\d+)/)[1]) - Number(a.match(/v(\d+)/)[1]));
      } catch { noLogFile++; continue; }
      if (logFiles.length === 0) { noLogFile++; continue; }
      let raw;
      try {
        raw = execFileSync('zstd', ['-dc', join(sdPath, logFiles[0])], { maxBuffer: 1 << 29 });
      } catch { decodeFail++; continue; }
      const rec = parseSession(raw.toString('utf8'));
      raw = null;
      if (rec.id === null) { headerFail++; continue; }
      sessions.push(rec);
      if (LIMIT > 0 && sessions.length >= LIMIT) {
        console.log(`（--limit ${LIMIT} 提前截断：以下数字只覆盖部分数据，不构成判定依据）`);
        return { sessions, wsDirs, sessionDirs, noLogFile, decodeFail, headerFail, truncated: true };
      }
    }
  }
  return { sessions, wsDirs, sessionDirs, noLogFile, decodeFail, headerFail, truncated: false };
}

// ============================================================================
// 命中判定
// ============================================================================
/** 三档命中：精确 / 前缀(候选⊑真实) / 任意向。norm 为空的候选不参与前缀档（空串前缀恒真）。 */
function hitFlags(candNorm, realNorm) {
  const exact = candNorm === realNorm;
  const realEmpty = realNorm === '';
  const prefix = !realEmpty && candNorm !== '' && realNorm.startsWith(candNorm);
  const anyPrefix = prefix || (!realEmpty && candNorm !== '' && candNorm.startsWith(realNorm)) || exact;
  return { exact, prefix, anyPrefix };
}

/**
 * 时间序 LOO 预测：按 createdAt 升序遍历**全部**会话（表按 tableKind 过滤参与者），
 * 只对 evalKind 里的会话打分。表条目：norm → {count, lastAt, cwdSet:Set}。
 * 返回累积曲线、top-1 污染占比、新颖率上界、（wsKind 时）同工作区分表对照。
 */
function runSweep(sessionsSorted, tableKind, evalKind, wsScopedTop) {
  const globalTable = new Map();
  const wsTables = new Map(); // cwd → Map(norm → {count,lastAt})
  const curve = { exact: {}, prefix: {}, anyPrefix: {} };
  for (const k of K_CURVE) for (const key of Object.keys(curve)) curve[key][k] = 0;
  const out = {
    evaluated: 0, cold: 0, // cold = 预测时表为空（机器初启，无从预测）
    top1CrossWs: 0, top1HasPrediction: 0,
    novel: 0, // 真实首句在任何更早会话的 opener 里出现过（= 频次法结构上界）
    normEmptyOpener: 0,
    wsCurve: null,
  };
  if (wsScopedTop) out.wsCurve = { top1Prefix: 0, top3Prefix: 0, evaluated: 0 };

  const eligible = (rec) => (tableKind === 'all' ? true : tableKind === 'human' ? !rec.machine : rec.machine === evalKind);
  const matchesEval = (rec) => (evalKind === 'all' ? true : evalKind === 'human' ? !rec.machine : rec.machine);

  for (const rec of sessionsSorted) {
    const opener = rec.texts.length > 0 ? normalizeForMatch(rec.texts[0]) : null;
    if (matchesEval(rec) && opener !== null) {
      if (opener === '') out.normEmptyOpener++;
      out.evaluated++;
      // top-K from global table
      const preds = [...globalTable.entries()]
        .filter(([norm]) => norm !== '')
        .sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt || (a[0] < b[0] ? -1 : 1))
        .slice(0, Math.max(...K_CURVE))
        .map(([norm]) => norm);
      if (preds.length === 0) {
        out.cold++;
      } else {
        for (const k of K_CURVE) {
          const top = preds.slice(0, k);
          let ex = 0, pf = 0, ap = 0;
          for (const c of top) {
            const f = hitFlags(c, opener);
            if (f.exact) ex = 1;
            if (f.prefix) pf = 1;
            if (f.anyPrefix) ap = 1;
          }
          curve.exact[k] += ex; curve.prefix[k] += pf; curve.anyPrefix[k] += ap;
        }
        out.top1HasPrediction++;
        const info = globalTable.get(preds[0]);
        if (info && rec.cwd !== '' && !info.cwdSet.has(rec.cwd)) out.top1CrossWs++;
        if (wsScopedTop && out.wsCurve) {
          const t = wsTables.get(rec.cwd);
          const wsPreds = t
            ? [...t.entries()].filter(([n]) => n !== '').sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt).slice(0, 3).map(([n]) => n)
            : [];
          if (wsPreds.length > 0) {
            out.wsCurve.evaluated++;
            if (hitFlags(wsPreds[0], opener).prefix) out.wsCurve.top1Prefix++;
            if (wsPreds.some((c) => hitFlags(c, opener).prefix)) out.wsCurve.top3Prefix++;
          }
        }
      }
      if (globalTable.has(opener) && opener !== '') out.novel++;
    }
    // 本会话入表（LOO：先预测后入表，预测看不到自己）
    if (eligible(rec) && opener !== null && opener !== '') {
      const ent = globalTable.get(opener) ?? { count: 0, lastAt: 0, cwdSet: new Set() };
      ent.count++;
      ent.lastAt = Math.max(ent.lastAt, rec.createdAt);
      if (rec.cwd !== '') ent.cwdSet.add(rec.cwd);
      globalTable.set(opener, ent);
      if (wsScopedTop) {
        const t = wsTables.get(rec.cwd) ?? new Map();
        const w = t.get(opener) ?? { count: 0, lastAt: 0 };
        w.count++;
        w.lastAt = Math.max(w.lastAt, rec.createdAt);
        t.set(opener, w);
        wsTables.set(rec.cwd, t);
      }
    }
  }
  out.curve = curve;
  out.tableSize = globalTable.size;
  return out;
}

// ============================================================================
// 对照器与截断偏差
// ============================================================================
/** 同会话内后续消息重复率（现役历史补全的供给形态）：micro —— Σ重复 / Σ(i≥2 消息)。 */
function inSessionRepeatRate(human) {
  let repeats = 0, total = 0;
  for (const rec of human) {
    const seen = new Set();
    let i = 0;
    for (const t of rec.texts) {
      const n = normalizeForMatch(t);
      if (i > 0) {
        total++;
        if (n !== '' && seen.has(n)) repeats++;
      }
      if (n !== '') seen.add(n);
      i++;
    }
  }
  return { repeats, total, rate: total === 0 ? 0 : repeats / total };
}

/** 环截断：n>HISTORY_PUSH_CAP 时推送窗口(slice(-CAP))看不见首句；n>RING_CAPACITY 时环首元素本身掉出。 */
function ringTruncation(human) {
  let pushCut = 0, ringCut = 0, n0 = 0;
  const counts = [];
  for (const rec of human) {
    const n = rec.texts.length;
    if (n === 0) { n0++; continue; }
    counts.push(n);
    if (n > HISTORY_PUSH_CAP) pushCut++;
    if (n > RING_CAPACITY) ringCut++;
  }
  counts.sort((a, b) => a - b);
  const q = (p) => (counts.length === 0 ? 0 : counts[Math.min(counts.length - 1, Math.floor(counts.length * p))]);
  const openers = human.filter((r) => r.texts.length > 0).flatMap((r) => [normalizeForMatch(r.texts[0])].map(() => r.texts[0].length));
  openers.sort((a, b) => a - b);
  const qo = (p) => (openers.length === 0 ? 0 : openers[Math.min(openers.length - 1, Math.floor(openers.length * p))]);
  return {
    withMsgs: counts.length, empty: n0, pushCut, ringCut,
    pushCutPct: counts.length === 0 ? 0 : pushCut / counts.length,
    ringCutPct: counts.length === 0 ? 0 : ringCut / counts.length,
    p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1),
    openerLenP50: qo(0.5), openerLenP90: qo(0.9), openerLenMax: qo(1),
  };
}

// ============================================================================
// 主流程
// ============================================================================
const t0 = Date.now();
console.log(`# scaffold-opener-hitrate · 只读 · sessions-root=${SESSIONS_ROOT}`);
const collected = collect();
const { sessions } = collected;

// id 去重（同一会话在目录树里出现两份时保 createdAt 早的那份；实测本机 id 全唯一）。
const byId = new Map();
let dupId = 0;
for (const rec of sessions) {
  const prev = byId.get(rec.id);
  if (prev === undefined) byId.set(rec.id, rec);
  else { dupId++; if (rec.createdAt < prev.createdAt) byId.set(rec.id, rec); }
}
const uniq = [...byId.values()];
const human = uniq.filter((r) => !r.machine);
const machine = uniq.filter((r) => r.machine);
const humanWithOpener = human.filter((r) => r.texts.length > 0);
// 「人开但提不出首句」原因分档（每会话只归一类，优先报更像结构性缺失的档）。
function emptyReason(rec) {
  const u = rec.um;
  if (u.events === 0) return '无 user/message 事件';
  if (u.valid > 0) return '分档矛盾(异常,应 0)';
  if (u.nonUser === u.events) return '全部非 user 来源(注入/转写)';
  if (u.tooLong > 0) return `含超 ${HISTORY_TEXT_MAX_CHARS} 字符大段(首条即被筛掉)`;
  return '全为空文本/system-reminder';
}
const emptyReasons = new Map();
for (const r of human) {
  if (r.texts.length === 0) {
    const k = emptyReason(r);
    emptyReasons.set(k, (emptyReasons.get(k) ?? 0) + 1);
  }
}
const totalUserMsgs = uniq.reduce((s, r) => s + r.texts.length, 0);
const humanUserMsgs = human.reduce((s, r) => s + r.texts.length, 0);
const cwds = new Set(uniq.filter((r) => r.cwd !== '').map((r) => r.cwd));

const sorted = [...uniq].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

// —— 打印（聚合数字，正文零外泄） ——
console.log('\n—— 1 数据可得性 ——');
console.log(`会话目录 ${collected.sessionDirs}（工作区目录 ${collected.wsDirs}）；日志缺失 ${collected.noLogFile}；解码失败(超缓冲/坏档) ${collected.decodeFail}；无会话头 ${collected.headerFail}；id 重复合并 ${dupId}；有效会话 ${uniq.length}${collected.truncated ? '【--limit 截断，非全量】' : ''}`);
console.log(`口径：真人消息筛选=宿主同款 extractHistory（source.kind 白名单+相邻去重+跳系统注入/超长）；归一化=normalizeForMatch；首句=会话内第 1 条入环文本（即今天「环首元素」的语义）。`);
console.log(`工作区字段：日志头 cwd 覆盖 ${cwds.size} 个不同路径，缺失会话 ${uniq.filter((r) => r.cwd === '').length} ⇒ 跨项目可区分：${uniq.every((r) => r.cwd !== '') ? 'COVERED' : 'COVERED(部分缺失,计占比时排除)'}。`);
const emptyHuman = human.length - humanWithOpener.length;
console.log(`人开会话里提不出首句的 ${emptyHuman} 个，原因分档：${[...emptyReasons].map(([k, v]) => `${k} ${v}`).join(' · ') || '（无）'}（这是「首句标记」的真实覆盖率：${pct(humanWithOpener.length, human.length)} 的人开会话能离线提出首句）`);
// 「全部非 user 来源」档的成因直方图：这些是 webhook/插件/上下文注入撑起来的会话（人开壳、机器输入），
// 运行时的历史环同样为空 ⇒ 它们不配进 opener 统计的分母，命中率没有被这批会话稀释。
const injKinds = new Map();
let injSessions = 0;
for (const r of human) {
  if (r.texts.length === 0 && r.um.events > 0 && r.um.nonUser === r.um.events && r.um.tooLong === 0 && r.um.emptyish === 0) {
    injSessions++;
    for (const [k, v] of r.um.kinds) injKinds.set(k, (injKinds.get(k) ?? 0) + v);
  }
}
if (injSessions > 0) {
  console.log(`其中 ${injSessions} 个是纯注入会话（真人一条未打），非 user 来源事件直方图：${[...injKinds].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' · ')}`);
}

console.log('\n—— 2 样本量 ——');
console.log(`人开会话 ${human.length}（其中有首句 ${humanWithOpener.length}）· 机器开会话 ${machine.length} · 真人消息总数 ${totalUserMsgs}（人开 ${humanUserMsgs}）`);

const sweepAll = runSweep(sorted, 'all', 'human', true);   // 变体 A：表含机器开 —— 判据主数
const sweepHuman = runSweep(sorted, 'human', 'human', false); // 变体 B：纯人表 —— 上限对照
const sweepMachine = runSweep(sorted, 'all', 'machine', false); // 对照行：机器开会话被模板重复撑起的命中率

console.log('\n—— 3 top-1 命中率（人开会话 · 时间序 LOO · 表=全部会话[变体 A]）——');
console.log(`K=1：精确 ${pct(sweepAll.curve.exact[1], sweepAll.evaluated - sweepAll.cold)} · 前缀 ${pct(sweepAll.curve.prefix[1], sweepAll.evaluated - sweepAll.cold)} · 任意向 ${pct(sweepAll.curve.anyPrefix[1], sweepAll.evaluated - sweepAll.cold)}（分母=可预测会话 ${sweepAll.evaluated - sweepAll.cold}，冷启动 ${sweepAll.cold}，opener 归一化后为空 ${sweepAll.normEmptyOpener}）`);
console.log(`对照·变体 B 纯人表 K=1：精确 ${pct(sweepHuman.curve.exact[1], sweepHuman.evaluated - sweepHuman.cold)} · 前缀 ${pct(sweepHuman.curve.prefix[1], sweepHuman.evaluated - sweepHuman.cold)}（表 ${sweepHuman.tableSize} 条 vs A 表 ${sweepAll.tableSize} 条）`);
console.log(`对照·机器开会话(表A) K=1 前缀：${pct(sweepMachine.curve.prefix[1], sweepMachine.evaluated - sweepMachine.cold)} —— subagent 委托模板彼此高度重复，若这行显著高于人开行，说明"高频"主要来自模板而非真实复用`);

console.log('\n—— 4 top-K 累积命中率（前缀口径 · 变体 A）——');
for (const k of K_CURVE) {
  console.log(`K=${String(k).padStart(2)}：前缀 ${pct(sweepAll.curve.prefix[k], sweepAll.evaluated - sweepAll.cold)} · 精确 ${pct(sweepAll.curve.exact[k], sweepAll.evaluated - sweepAll.cold)} · 任意向 ${pct(sweepAll.curve.anyPrefix[k], sweepAll.evaluated - sweepAll.cold)}`);
}

console.log('\n—— 5 跨项目污染 ——');
console.log(`top-1 候选支撑会话**全部来自其它工作区**：${sweepAll.top1CrossWs}/${sweepAll.top1HasPrediction} = ${pct(sweepAll.top1CrossWs, sweepAll.top1HasPrediction)}`);
if (sweepAll.wsCurve) {
  console.log(`对照（工作区分表，需项目维度才做得到）：top-1 前缀 ${pct(sweepAll.wsCurve.top1Prefix, sweepAll.wsCurve.evaluated)} · top-3 前缀 ${pct(sweepAll.wsCurve.top3Prefix, sweepAll.wsCurve.evaluated)}（同工作区有更早会话可预测的样本 ${sweepAll.wsCurve.evaluated}）`);
}

console.log('\n—— 6 环截断偏差（人开会话）——');
const rt = ringTruncation(human);
console.log(`消息数分布：p50=${rt.p50} p90=${rt.p90} p99=${rt.p99} max=${rt.max}；空会话(0 条真人消息) ${rt.empty}`);
console.log(`> 推送窗口 ${HISTORY_PUSH_CAP}（首句掉出 client 可见窗）：${rt.pushCut}/${rt.withMsgs} = ${pct(rt.pushCut, rt.withMsgs)}`);
console.log(`> 环容量 ${RING_CAPACITY}（「环首元素=第一句」当场失效）：${rt.ringCut}/${rt.withMsgs} = ${pct(rt.ringCut, rt.withMsgs)}`);
console.log(`首句长度（字符数，不涉内容）：p50=${rt.openerLenP50} p90=${rt.openerLenP90} max=${rt.openerLenMax}`);

console.log('\n—— 7 结论 ——');
const repeat = inSessionRepeatRate(human);
const denom = sweepAll.evaluated - sweepAll.cold;
const top1 = denom > 0 ? sweepAll.curve.prefix[1] / denom : -1;
const top10 = denom > 0 ? sweepAll.curve.prefix[10] / denom : -1;
const ceiling = sweepAll.evaluated > 0 ? sweepAll.novel / sweepAll.evaluated : -1; // 任意 opener 频次法的结构上界(精确匹配意义下,任意名次)
console.log(`对照器：opener 新颖率上界 ${pct(sweepAll.novel, sweepAll.evaluated)}（真实首句在更早会话里当过首句的比例 —— 排序再好也超不过它）`);
console.log(`对照器：同会话后续消息重复率 ${pct(repeat.repeats, repeat.total)}（micro；现役历史补全的复用供给形态）`);
console.log(`判据（提案阈值，先写在头注释再看数）：变体 A 前缀口径 top-1 ≥ ${(THRESHOLD_TOP1_PREFIX * 100).toFixed(0)}% 且 top-10 ≥ ${(THRESHOLD_TOP10_PREFIX * 100).toFixed(0)}%`);
let verdict;
if (humanWithOpener.length < MIN_UNIVERSE) {
  verdict = 'NOT-COVERED';
  console.log(`NOT-COVERED：人开且有首句的会话 ${humanWithOpener.length} < ${MIN_UNIVERSE}，样本不足以支撑任一判定。缺失前置：更多真实使用数据/或换 --sessions-root 指向含历史机的目录。`);
} else if (top1 >= THRESHOLD_TOP1_PREFIX && top10 >= THRESHOLD_TOP10_PREFIX) {
  verdict = 'PASS';
  console.log(`PASS：top-1 前缀 ${pct(sweepAll.curve.prefix[1], denom)} ≥ ${(THRESHOLD_TOP1_PREFIX * 100).toFixed(0)}% 且 top-10 ${pct(sweepAll.curve.prefix[10], denom)} ≥ ${(THRESHOLD_TOP10_PREFIX * 100).toFixed(0)}% ⇒ 零 token 路值得做（污染率与截断行仍在上面，实现时按数字决定要不要工作区维度/首句标记）。`);
} else {
  verdict = 'FAIL';
  const reason = [];
  if (top1 < THRESHOLD_TOP1_PREFIX) reason.push(`top-1 前缀 ${pct(sweepAll.curve.prefix[1], denom)} 低于 ${(THRESHOLD_TOP1_PREFIX * 100).toFixed(0)}%`);
  if (top10 < THRESHOLD_TOP10_PREFIX) reason.push(`top-10 前缀 ${pct(sweepAll.curve.prefix[10], denom)} 低于 ${(THRESHOLD_TOP10_PREFIX * 100).toFixed(0)}%`);
  console.log(`FAIL：${reason.join('、')} ⇒ 零 token 路不值得做，直接进 P1（LLM 起稿）。`);
  if (ceiling >= 0 && ceiling < THRESHOLD_TOP1_PREFIX) {
    console.log(`加强判定：opener 新颖率上界本身（${pct(sweepAll.novel, sweepAll.evaluated)}）就低于阈值 —— 与候选排序/宽度无关，这条路的**数据上限**不达标。`);
  }
}
console.log(`\n阈值性质声明：本仓无幽灵采纳率遥测，20%/50% 是从「空草稿幽灵对每个新会话都出现」的展示代价 + 上面两个实测对照推出的**提案线**，不是历史实证；判据变更应留痕在 #124。`);
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(verdict === 'NOT-COVERED' ? 2 : 0);
