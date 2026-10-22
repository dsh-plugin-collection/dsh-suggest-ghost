#!/usr/bin/env node
/**
 * 一次性离线量度（**故意不接 `test:smoke` 链**，理由同 `hot-window-staleness.mjs` 头部）。
 *
 * 它回答的是 `hot-window-staleness.mjs` **回答不了**的那一半问题：
 * 那边的 12.6% 是「快照落后**一整个回合**」的代价；而 1000ms 窗口最多让快照落后
 * `窗口 + 泵间隔 = 1500ms` ⇒ 真踩得到吗？要踩到，需要「用户发出上一条之后 ≤1.5s
 * 内就打出以它为前缀的草稿」。这里用真实日志的事件 `time` 字段量这个比值。
 *
 * 跑法：`node --experimental-strip-types scripts/hot-window-timeline.mjs [文件数]`
 * 实测（173 会话 / 1712 个相邻输入间隔）：p50 = **341 秒**、p90 = 3758 秒、
 * **≤1500ms 的只有 5/1712 = 0.29%**；「上一条是本条前缀」那类 83 例里间隔 ≤1.5s 的
 * 只有 **3 例 = 3.61%**。⇒ 合成可见代价 ≈ 0.91% × 3.61% ≈ **0.033%（3/8134 判定）**。
 *
 * 通用结论（比数字更值得留）：**陈旧窗口能否造成用户可见代价，取决于
 * 「用户输入节奏 ÷ 陈旧上界」这个比值，而不是窗口本身多大**。本机这个比值是三个数量级
 * ⇒ 窗口 1000ms 的代价是纸面的。反过来，若宿主出现程序化连发（IM/委派/自动补投，
 * 相邻 ≤1.5s），那 12.6% 会变成真实代价 ⇒ 该防的是**连发**（首字符到达即让路，
 * 也就是 `pull 让路` 的推广），**调小窗口是钝器**。见 issue #63。
 *
 * 隐私：同样**只打印计数与分位数，不打印任何正文**。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractHistory, historySuggestion, normalizeForMatch } from '../src/client/history.ts';

const ROOT = join(homedir(), '.dsh', 'sessions');
const MAX_FILES = Number(process.argv[2] ?? 260);
const WINDOW_BOUND_MS = 1500; // 窗口 1000 + 泵 500
const MIN_CHARS = 3;

/** 一条会话里的 (用户文本, 时间) 对 —— 时间戳取该 user/message 事件的 time。 */
function timedUserMessages(file) {
  try {
    const raw = file.endsWith('.zstd')
      ? execFileSync('unzstd', ['-c', file], { maxBuffer: 1 << 26 })
      : readFileSync(file);
    const out = [];
    for (const line of raw.toString('utf8').split('\n')) {
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'user/message') continue;
      const texts = extractHistory([{ kind: 'user', data: e.data }]);
      if (texts.length === 0) continue; // 系统注入 / 空白 / 超长都被 extractHistory 滤掉
      out.push({ text: texts[0], time: Number(e.time ?? 0) });
    }
    return out;
  } catch {
    return [];
  }
}

function listFiles(limit) {
  const out = [];
  if (!existsSync(ROOT)) return out;
  for (const project of readdirSync(ROOT)) {
    const pdir = join(ROOT, project);
    let sessions;
    try { sessions = readdirSync(pdir); } catch { continue; }
    for (const s of sessions) {
      const f = join(pdir, s, 'session.jsonl.zstd');
      const f2 = join(pdir, s, 'session.jsonl');
      const file = existsSync(f) ? f : (existsSync(f2) ? f2 : null);
      if (file === null) continue;
      try { if (statSync(file).size > 6 * 1024 * 1024) continue; } catch { continue; }
      out.push(file);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

let gaps = [];
let bTotal = 0;
let bWithinWindow = 0;
let sessionsUsed = 0;

for (const file of listFiles(MAX_FILES)) {
  const msgs = timedUserMessages(file);
  if (msgs.length < 3) continue;
  sessionsUsed += 1;
  for (let i = 1; i < msgs.length; i += 1) {
    const dt = msgs[i].time - msgs[i - 1].time;
    if (!Number.isFinite(dt) || dt < 0) continue;
    gaps.push(dt);
    // B：这一条是否以「上一条」为前缀（= 新鲜态的候选正是窗口还没同步的那一条）
    const prev = normalizeForMatch(msgs[i - 1].text);
    const cur = normalizeForMatch(msgs[i].text);
    if (prev.length < MIN_CHARS || cur.length < MIN_CHARS) continue;
    // 用户重打/续打上一条的前缀：草稿取当前条的前缀，只要能匹配上 prev 就算这类场景
    const draftLen = Math.max(MIN_CHARS, Math.floor(cur.length * 0.5));
    const draft = cur.slice(0, draftLen);
    if (!prev.startsWith(normalizeForMatch(draft)) || prev === normalizeForMatch(draft)) continue;
    bTotal += 1;
    if (dt <= WINDOW_BOUND_MS) bWithinWindow += 1;
  }
}

const pct = (n, d) => (d === 0 ? 0 : (100 * n) / d);
const q = (arr, p) => {
  if (arr.length === 0) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
};

console.log(`\n真实时间轴核对：${sessionsUsed} 个会话 · ${gaps.length} 个「相邻两条用户输入」的间隔`);
console.log(`间隔分布：p50=${(q(gaps, 0.5) / 1000).toFixed(1)}s p90=${(q(gaps, 0.9) / 1000).toFixed(1)}s 最短=${(q(gaps, 0.0) / 1000).toFixed(2)}s`);
for (const [label, bound] of [['≤1.5s（窗口+泵的实际陈旧上界）', 1500], ['≤3s', 3000], ['≤10s', 10000]]) {
  const n = gaps.filter((g) => g <= bound).length;
  console.log(`  ${label.padEnd(34)} ${n} / ${gaps.length} = ${pct(n, gaps.length).toFixed(2)}%`);
}
console.log(`\n「会因陈旧而丢候选」那一类草稿（上一条是本条的前缀）：${bTotal} 例`);
console.log(`  其中相邻间隔 ≤ ${WINDOW_BOUND_MS}ms（窗口真能踩到的）：${bWithinWindow} 例 = ${pct(bWithinWindow, bTotal).toFixed(2)}%`);
console.log(`  其余 ${pct(bTotal - bWithinWindow, bTotal).toFixed(2)}% 发生在窗口早已落地之后 ⇒ 陈旧模型对它们不成立`);
