#!/usr/bin/env node
/**
 * 一次性离线量度（**故意不接 `test:smoke` 链** —— 它读真实用户日志、非确定性、耗时数十秒，
 * 进链等于给门禁加一个"依赖某台机器上有哪些会话"的负担）。
 *
 * 它证明的事：`_hot` 那 1000ms 合并窗口的**用户可见代价**。窗口延迟的是整格
 * `{hot, total, history}`，所以按 lead 定的口径分三种陈旧态各量一遍：
 *  (a) 只有热表旧（环新）  (b) 只有环旧（热表新）  (c) 两者都旧（= 真实窗口延迟的对象）
 * 报的三件事**能证伪**（不是分数差）：① 候选换没换人 ② 幽灵后缀长度差
 * ③ 候选有没有整个消失（新鲜态有、陈旧态无 = 用户说的「这次没补出来」）。
 *
 * 跑法：`node --experimental-strip-types scripts/hot-window-staleness.mjs [会话数]`
 * 实测量级（本机 120 会话 / 8134 次判定 / 新鲜态有候选 588 次）：
 *   (a) 换人 4.1% · 消失 **0.0%** —— `hotCounts` 只改已有候选的**排序**（权重 0.3 < recency 1.0），
 *       不改候选集合，所以热表单独陈旧丢不了候选；
 *   (b) 换人 6.1% · 消失 cs=0 时 12.6%、cs=1 时 **0.0%** —— 跨会话候选来自热表 extras，
 *       环里缺的那条还在 extras 里就兜得住；
 *   (c) 换人 6.1% · 消失 **12.6%**（两种 crossSession 设置同值 ⇒ extras 也旧了，兜不住）；
 *   机制核对：**111 例消失里 111 例（100%）的候选正是「窗口还没同步的那一条」**，其他原因 0 例。
 *   无条件率（分母=全部判定）：(a) 0.00% · (b) 0.45% · (c) 0.91%。
 *
 * ## ⚠️ 这两个数是**上界模型**，不是窗口的真实代价
 * 这里的"陈旧"= 环与热表**都缺上一条用户输入**（落后一整个回合）。而窗口的陈旧上界是
 * `窗口 + 一个泵间隔 = 1500ms`。⇒ 12.6% 那个数是「落后一整回合会怎样」，
 * **窗口够不够得着由 `scripts/hot-window-timeline.mjs` 量**（结论：合成后 ≈0.033%）。
 * 两个脚本必须一起读，只读这个会把一个够不着的代价说成常态。
 *
 * ## 这份脚本最有价值的部分是下面这个坑（第一次跑差点得出假结论）
 * 取样时按项目目录限制"每个项目最多 3 个会话"，于是 `MAX_SESSIONS=400` 的请求实际只翻了
 * **30 个文件**：分母 = 66 次判定，而**表格里的 0% / 6.1% / 100% 看起来完全正常**。
 * 样本小到不足以支撑任何结论的时候，输出不会报错，只会显得"已经收敛"。
 * ⇒ 所以：① 每项目上限放开（现在 300）；② 每次跑都打印 `sessionsUsed / 判定总数 / 有候选的判定数`
 * 三个数；③ **同时报条件比例与无条件比例**，只报前者会把小事件说得像很严重。
 *
 * 隐私：**不打印任何会话正文**（只打印计数、比例、时长分位数）—— 与 `sandbox.greps` 那条
 * "留痕只打数值"的口径一致。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { extractHistory, historySuggestion, normalizeForMatch, HISTORY_WEIGHTS } from '../src/client/history.ts';
import { readFileSync as __rf } from 'node:fs';
import { fileURLToPath as __url } from 'node:url';
import { dirname as __dn } from 'node:path';
const __root = join(__dn(__url(import.meta.url)), '..');
/**
 * 仓内**默认值**（注意：现网 profile 把它改成了 true，那是运行时配置，不是这里读的）。
 * 两个来源都查一遍，查不到就当 false —— 这个数只用于解释 cs=0/cs=1 哪一行贴近线上。
 */
const CROSS_DEFAULT = ['src/index.ts', 'src/domain.ts']
  .map((f) => { try { return __rf(join(__root, f), 'utf8'); } catch { return ''; } })
  .some((s) => /historyCrossSession[\s\S]{0,140}?default\(true\)/.test(s));

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions');
const MAX_SESSIONS = Number(process.argv[2] ?? 400);
const MIN_USER_MSGS = 4;
const MAX_DRAFTS_PER_SESSION = 60;
const MIN_CHARS = 3; // 客户端 historyMinChars 的量级

/** 读一个会话的用户输入序列（真实日志，不是我编的分布）。 */
function userTextsOf(file) {
  try {
    const raw = file.endsWith('.zstd')
      ? execFileSync('unzstd', ['-c', file], { maxBuffer: 1 << 26 })
      : readFileSync(file);
    const events = raw.toString('utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    // `extractHistory` 认的是 **kind**（'user' / 'user/message'），不是事件表的 type；
    // 传 type 进去会被全量跳过 ⇒ 样本静默变成 0，这种「没数据也算跑完」的坑必须显式防。
    const nodes = events
      .filter((e) => e.type === 'user/message' || e.kind === 'user')
      .map((e) => ({ kind: 'user', data: e.data }));
    const texts = extractHistory(nodes);
    if (texts.length === 0 && events.length > 0) return ['__EMPTY__']; // 标记：日志非空但提取不到 ⇒ 统计里报出来
    return texts.map((t) => String(t).trim()).filter((t) => t !== '');
  } catch {
    return [];
  }
}

function listSessionFiles(limit) {
  const out = [];
  if (!existsSync(SESSIONS_ROOT)) return out;
  for (const project of readdirSync(SESSIONS_ROOT)) {
    const pdir = join(SESSIONS_ROOT, project);
    let sessions;
    try { sessions = readdirSync(pdir); } catch { continue; }
    // 分散取样：每个项目目录最多取 3 个，避免全是同一个项目的会话
    let taken = 0;
    for (const s of sessions) {
      const f = join(pdir, s, 'session.jsonl.zstd');
      const f2 = join(pdir, s, 'session.jsonl');
      const file = existsSync(f) ? f : (existsSync(f2) ? f2 : null);
      if (file === null) continue;
      let size = 0;
      try { size = statSync(file).size; } catch { continue; }
      if (size > 6 * 1024 * 1024) continue; // 跳过超大文件，控制运行时间
      out.push(file);
      taken += 1;
      // 每个项目目录取样上限：原来写死 3 个，导致「400 个会话」的请求实际只翻了 30 个文件
      // 就收工 —— 分母小到自己都该怀疑。放开到 30，并在末尾报实际读取的文件数。
      if (taken >= 300) break; // 每项目上限：一次跑要能真的把可用会话吃进来（原来 3 个把样本卡在 46 个）
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** 归一化文本 → 频次（就是 `hotCounts` 那张 Map 的形状）。 */
function hotMapOf(texts) {
  const m = new Map();
  for (const t of texts) {
    const norm = normalizeForMatch(t);
    if (norm === '') continue;
    m.set(norm, (m.get(norm) ?? 0) + 1);
  }
  return m;
}

/** 跨会话候选（热度 top-K），对应 host 在 crossSession=true 时塞进 `_hot.hot` 的那一份。 */
function extraOf(hot) {
  return [...hot.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 50)
    .map(([text, count]) => ({ text, count }));
}

function runState(history, draft, hot, extra) {
  return historySuggestion(history, draft, {
    minChars: MIN_CHARS,
    maxEntries: 0,
    hotCounts: hot,
    ...(extra ? { extraCandidates: extra } : {}),
  });
}

let noCandidate = 0;
/** 机制核对：消失的那些案例里，新鲜态选中的候选**是不是**就是「窗口还没同步的那一条」。 */
let mechNewest = 0;
let mechOther = 0;
const stats = { drafts: 0, withFreshCandidate: 0 };
const states = ['a_hot', 'b_ring', 'c_both'];
// crossSession 必须分开统计：(b)/(c) 的差别只在「最新那句还在不在候选集里」，而
// crossSession=true 时它可能通过跨会话候选（extras）留下 —— 合在一起统计会把
// 「环陈旧」与「跨会话候选兜住」两件事混成一个数。
const csSplit = true;
const accBase = Object.fromEntries(
  states.flatMap((k) => ['cs=0', 'cs=1'].map((cs) => [`${k}|${cs}`, {
    changed: 0, disappeared: 0, appeared: 0, same: 0, suffixDiff: [],
  }])),
);
const acc = structuredClone(accBase);

let sessionsUsed = 0;
let draftsTotal = 0;
let extractedEmpty = 0;
let tooShort = 0;
for (const file of listSessionFiles(MAX_SESSIONS)) {
  const u = userTextsOf(file);
  if (u.length >= 1 && u[0] === '__EMPTY__') { extractedEmpty += 1; continue; }
  if (u.length < MIN_USER_MSGS) { tooShort += 1; continue; }
  sessionsUsed += 1;
  const n = Math.min(u.length - 1, MAX_DRAFTS_PER_SESSION + MIN_USER_MSGS);
  for (let i = MIN_USER_MSGS - 1; i < n; i += 1) {
    // draft = 第 i 句的前缀（真实用户会打出来的中间态），取 30%/60%/90% 三档
    const full = u[i];
    const norm = normalizeForMatch(full);
    if (norm.length < MIN_CHARS + 2) continue;
    for (const frac of [0.3, 0.6, 0.9]) {
      const cut = Math.max(MIN_CHARS, Math.floor(norm.length * frac));
      const draft = full.slice(0, Math.min(full.length, Math.ceil(full.length * frac)));
      if (normalizeForMatch(draft).length < MIN_CHARS) continue;

      // 新鲜态：环与热表都含第 i-1 句的贡献；陈旧一拍 = 都不含（真实窗口的效果）
      const histFresh = u.slice(0, i);
      const histStale = u.slice(0, Math.max(0, i - 1));
      const hotFresh = hotMapOf(histFresh);
      const hotStale = hotMapOf(histStale);

      for (const crossSession of [false, true]) {
        const extraFresh = crossSession ? extraOf(hotFresh) : undefined;
        const extraStale = crossSession ? extraOf(hotStale) : undefined;
        const fresh = runState(histFresh, draft, hotFresh, extraFresh);
        draftsTotal += 1;
        stats.drafts += 1;
        if (fresh === undefined) { noCandidate += 1; continue; } // 新鲜态本来就没候选 ⇒ 陈旧不可能"弄没"
        stats.withFreshCandidate += 1;
        const variants = {
          a_hot: runState(histFresh, draft, hotStale, extraStale),      // 环新、热表旧
          b_ring: runState(histStale, draft, hotFresh, extraFresh),     // 热表新、环旧
          c_both: runState(histStale, draft, hotStale, extraStale),     // 最坏态
        };
        for (const [key0, stale] of Object.entries(variants)) {
          const key = csSplit ? `${key0}|cs=${crossSession ? 1 : 0}` : key0;
          if (acc[key] === undefined) acc[key] = { changed: 0, disappeared: 0, appeared: 0, same: 0, suffixDiff: [] };
          const bucket = acc[key];
          if (stale === undefined) {
            bucket.disappeared += 1;
            if (key0 !== 'a_hot') {
              // 陈旧态缺的那一条 = histFresh 的最后一条
              const missing = histFresh[histFresh.length - 1];
              if (missing !== undefined && normalizeForMatch(missing) === normalizeForMatch(fresh)) mechNewest += 1;
              else mechOther += 1;
            }
            continue;
          }
          if (normalizeForMatch(stale) === normalizeForMatch(fresh)) {
            bucket.same += 1;
            bucket.suffixDiff.push(0);
          } else {
            bucket.changed += 1;
            bucket.suffixDiff.push(
              Math.max(0, normalizeForMatch(fresh).length - normalizeForMatch(draft).length)
              - Math.max(0, normalizeForMatch(stale).length - normalizeForMatch(draft).length),
            );
          }
        }
      }
    }
  }
}

const pct = (n, d) => (d === 0 ? 0 : (100 * n) / d);
const quantile = (arr, q) => {
  if (arr.length === 0) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * q))];
};

console.log(`\n真实日志量度：_hot 陈旧一拍（= 1000ms 合并窗口的效果）对历史补全的影响`);
console.log(`样本：${sessionsUsed} 个真实会话 · ${draftsTotal} 次「草稿 × 陈旧态 × crossSession」组合`
  + `（跳过：非真实用户输入/提取为空 ${extractedEmpty} 个、少于 ${MIN_USER_MSGS} 句 ${tooShort} 个）`);
console.log(`其中**新鲜态有候选**的判定次数 = ${stats.withFreshCandidate}（①②③ 的分母）`);
console.log(`权重：recency=${HISTORY_WEIGHTS.recency} localFreq=${HISTORY_WEIGHTS.localFreq} hotFreq=${HISTORY_WEIGHTS.hotFreq} suffixLen=${HISTORY_WEIGHTS.suffixLen}\n`);
console.log(`仓内默认 crossSession = ${CROSS_DEFAULT ? 'true（cs=1 才是线上形态）' : 'false'}`);
console.log('态 / crossSession          n     换人%    消失%    不变%   消失绝对数 后缀差中位/p95');
for (const key of Object.keys(accBase)) {
  const b = acc[key];
  const d = b.changed + b.disappeared + b.same + b.appeared;
  if (d === 0) { console.log(`${key.padEnd(24)} 0      —        —        —          0            —`); continue; }
  console.log(`${key.padEnd(24)} ${String(d).padStart(3)}  ${pct(b.changed, d).toFixed(1).padStart(6)}% ${pct(b.disappeared, d).toFixed(1).padStart(7)}% ${pct(b.same, d).toFixed(1).padStart(7)}% ${String(b.disappeared).padStart(8)}  ${quantile(b.suffixDiff, 0.5)} / ${quantile(b.suffixDiff, 0.95)}`);
}
// 汇总（不分 crossSession）也要有：结论只讲最坏态时用这一行
console.log(`\n机制核对（b_ring/c_both 的 ${mechNewest + mechOther} 例消失里）：候选正是「窗口没同步的那一条」= ${mechNewest} 例`
  + `（${pct(mechNewest, mechNewest + mechOther).toFixed(1)}%）· 其他原因 = ${mechOther} 例`);
console.log('\n汇总（两种 crossSession 设置合并）：');
for (const k of states) {
  const merged = Object.keys(acc).filter((x) => x.startsWith(`${k}|`)).reduce((m, x) => ({
    changed: m.changed + acc[x].changed, disappeared: m.disappeared + acc[x].disappeared,
    same: m.same + acc[x].same, appeared: m.appeared + acc[x].appeared,
    suffixDiff: m.suffixDiff.concat(acc[x].suffixDiff),
  }), { changed: 0, disappeared: 0, same: 0, appeared: 0, suffixDiff: [] });
  const d = merged.changed + merged.disappeared + merged.same + merged.appeared;
  console.log(`  ${k.padEnd(8)} n=${String(d).padStart(3)} 换人 ${pct(merged.changed, d).toFixed(1)}% · 消失 ${pct(merged.disappeared, d).toFixed(1)}%（${merged.disappeared} 例）· 不变 ${pct(merged.same, d).toFixed(1)}%`
    + ` · **无条件消失率**=${pct(merged.disappeared, draftsTotal).toFixed(2)}%（分母=全部判定 ${draftsTotal}）`);
}
console.log('\n读法：');
console.log(' · 「候选消失%」> 0 才是用户可见代价（新鲜态能补、陈旧态补不出）——这条显著非零就要开代码线。');
console.log(' · 「候选换人%」不必然更差：陈旧态少了一条最新输入，选中的可能是另一条同样合法的候选。');
console.log(' · 后缀长度差为负 = 陈旧态补得更长；为正 = 新鲜态补得更长。中位数为 0 说明多数草稿不受影响。');
