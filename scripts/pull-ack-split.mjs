#!/usr/bin/env node
/**
 * 把「pull 阶梯为什么不收敛」的三条成因**量成占比**（读宿主 tee 日志，不改任何行为）。
 *
 * ## 为什么需要它
 * `docs/pull-ack-investigation.md` 用六个场景证明了 B / D·E / F 三条机制**都成立、互不
 * 蕴含**，但那份文档同时记了一个实测缺口：**线上三条各占多少，日志判不出来**——原来
 * 落地留痕只有 `bytes=`，「2000 条热度但没带对账凭证」和「什么都没带」长得一样。
 * 现在落地行补了 `hasHistory=` / `ackSession=`（`src/trace-gate.ts` 的 `hotAckFields`），
 * 这个脚本就只做一件事：把每个会话的 pull 与「有没有带着 `ackSession=<本会话>` 的写落地」
 * join 起来，给出一张占比表。
 *
 * ## 归类判据（每条都注明是「实测」还是「启发式」）
 *  - **凭证已落地（≠已确认）**：该会话出现过 `ackSession=<本会话>` 的落地写
 *    （`hasHistory=1`）。`ackSession` 确实是载荷里的 `historySessionId`，也是客户端判据
 *    （`settings.historySessionId === pending.sessionId`）认的那个值——但「宿主写了」到
 *    「客户端认了」之间隔着三件本表**看不见**的事：事件有没有到达那一页、那一页的
 *    `frames.accept` 有没有把整条载荷丢掉（未验证，见文档待办第 4 条）、以及这条 pull
 *    是不是**同一个页签**发的（`_ops` 无页标识 ⇒ 两个页签交替 pull 同一会话会被宿主侧
 *    `pulls=5` 计数串成一个阶梯）。所以本表只能说「宿主的凭证到位了」。
 *  - **窗口内零凭证**：该会话有 pull 行、窗口里没有任何一笔写带走它的 `ackSession`。
 *    判据是「缺席」，所以它是**下界**：应答可能在窗口之外，也可能来自另一个页签的写。
 *  - **疑似 B 写了但没凭证**：该会话没有 ack 落地，但同窗口内有 `hasHistory=0` 的热度格写。
 *    ⚠️ **启发式**：`hasHistory=0` 的那一笔不指名会话（字段本来就缺席），只能按时间邻近
 *    归因；两个会话挨着 pull 时可能归错。表里把它单列，不与 A/D 混算。
 *  - **F 参与**：日志里出现过 `hot push withheld`（恢复 pending 期整格被扣）。这条只在
 *    「该会话全程无热格写」时作为**佐证**列出，不单独归类——留痕不指名会话。
 *  - **旧日志**：一行 `hasHistory=` 都没有 ⇒ 直接报「不可分」，不猜（补键之前的日志本来
 *    就没有这个信息量）。
 *
 * ## pull 行数的换算
 * `PULL_REPEAT_TRACE_EVERY=5` 之后同会话连续重复只留 `#1` 与 `pulls=5` 两行，**行数不等于
 * 事件数**。这里按「一行首现 = 1 个阶梯的开头」计数，并单独给出带计数行的数量作为阶梯跑满
 * 的证据（每出现一行 `[pulls=5]` 至少代表该会话把 5 次重试预算用完了）。
 *
 * 用法：`node scripts/pull-ack-split.mjs [日志路径]`（默认 `~/.dsh/dsh-web.log`）
 * 本脚本**故意不接进 `test:smoke`**：它读现场日志、输出报表，没有可断言的确定性判据
 * （同一类工具是 `hot-yield-ratio.mjs`）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const logPath = process.argv[2] ?? join(homedir(), '.dsh', 'dsh-web.log');
if (!existsSync(logPath)) {
  console.error(`日志不存在：${logPath}`);
  process.exit(2);
}
const lines = readFileSync(logPath, 'utf8').split('\n');
const traceOf = (l) => (l.includes('ops-trace] ') ? l.split('ops-trace] ').pop() : null);

// ── 采集 ────────────────────────────────────────────────────────────────────
/**
 * ⚠️ **窗口必须先界定，否则这张表是假的**（第一版就是这么错的）：补键之前的落地行没有
 * `hasHistory=`，它们的 ack 一律看不见 ⇒ 凡是应答落在旧窗口的会话全部被误判成
 * 「D/E 整笔被吞」。实测现场：2099 行里 593 条是旧形态落地行、只有 15 条带新键——按整份
 * 日志算就是 22/24 个会话"被吞"，那是**度量盲区**不是产品结论。
 * 所以只统计「第一条带键的落地行之后」的 pull，并把窗口外的量单独报出来当覆盖率。
 */
const windowStart = lines.findIndex((l) => / hasHistory=[01-] ackSession=/.test(l));
if (windowStart < 0) {
  process.stdout.write(`日志：${logPath}（${lines.length} 行）\n`);
  process.stdout.write('\n⛔ 这份日志里一个 `hasHistory=` 都没有 ⇒ 三条成因**判不出占比**，不是"没问题"。\n');
  process.stdout.write('   要么它来自补键之前，要么宿主还没加载新产物（看 `apply called; artifact mtime=` 那行）。\n');
  process.exit(1);
}
const window = lines.slice(windowStart);

const sessions = new Map();       // sessionId -> { pulls, acked, suspectB, firstLine, ladderFull }
const landings = [];              // { idx, hasHistory, ackSession }（idx 相对窗口）
let withheld = 0;
let keyBearing = 0;               // 带 hasHistory= 的落地行（新键生效的证据）
let legacyLanding = 0;            // 落地行但没有新键 ⇒ 混了旧日志

for (let i = 0; i < window.length; i += 1) {
  const t = traceOf(window[i]);
  if (t === null) continue;

  const pull = /^ops consumed: pull session=(\S+)/.exec(t);
  if (pull !== null) {
    const id = pull[1];
    const row = sessions.get(id) ?? { pulls: 0, acked: 0, suspectB: 0, firstLine: i + 1, ladderFull: 0 };
    row.pulls += 1;
    if (/pulls=\d+/.test(t)) row.ladderFull += 1;
    sessions.set(id, row);
    continue;
  }
  if (/^hot push withheld/.test(t)) { withheld += 1; continue; }

  const ack = / hasHistory=([01-]) ackSession=(\S+)/.exec(t);
  if (ack === null) {
    if (/^push landed |^hot push landed|^deferred push landed/.test(t)) legacyLanding += 1;
    continue;
  }
  keyBearing += 1;
  const [, hasHistory, ackSession] = ack;
  landings.push({ idx: i, hasHistory, ackSession });
  if (hasHistory === '1' && ackSession !== '-') {
    const row = sessions.get(ackSession);
    if (row !== undefined) row.acked += 1;
  }
}

// 窗口外的量（诚实边界：这些 pull 的归类不可信，不进上面的表）
let pullsBeforeWindow = 0;
for (let i = 0; i < windowStart; i += 1) {
  const t = traceOf(lines[i]);
  if (t !== null && /^ops consumed: pull session=/.test(t)) pullsBeforeWindow += 1;
}

// 疑似 B：hasHistory=0 的热度格写，按「窗口内最近一次 pull 的会话」归因（启发式，见文件头）
const pullOrder = [];
for (let i = 0; i < window.length; i += 1) {
  const t = traceOf(window[i]);
  if (t === null) continue;
  const p = /^ops consumed: pull session=(\S+)/.exec(t);
  if (p !== null) pullOrder.push({ idx: i, id: p[1] });
}
for (const l of landings) {
  if (l.hasHistory !== '0') continue;
  let last = null;
  for (const p of pullOrder) { if (p.idx < l.idx) last = p; else break; }
  if (last !== null) {
    const row = sessions.get(last.id);
    if (row !== undefined && row.acked === 0) row.suspectB += 1;
  }
}

// ── 报表 ────────────────────────────────────────────────────────────────────
const say = (s) => process.stdout.write(`${s}\n`);
const totalPullLines = [...sessions.values()].reduce((n, r) => n + r.pulls, 0);
say(`日志：${logPath}（${lines.length} 行）`);
say(`统计窗口 = 第 ${windowStart + 1} 行起（补键之后）；窗口内 pull ${totalPullLines} 行、`
  + `带新键的落地行 ${keyBearing} 条、旧形态落地行 ${legacyLanding} 条`);
if (pullsBeforeWindow > 0) {
  const cover = (100 * totalPullLines / (totalPullLines + pullsBeforeWindow)).toFixed(0);
  say(`⚠️ 窗口外还有 ${pullsBeforeWindow} 行 pull（补键之前），**不进这张表**：它们的应答落地`
    + '时没有 hasHistory= 这个键，缺席会被误判成「整笔被吞」。当前覆盖率 ' + `${cover}%——`
    + '窗口太短时，"窗口内零凭证"那一档是**度量盲区**而不是产品结论。');
}
say(`hot push withheld ${withheld} 行（F 的佐证；留痕不指名会话，故不参与归类）`);

const rows = [...sessions.entries()].map(([id, r]) => ({
  id,
  pulls: r.pulls,
  ladderFull: r.ladderFull,
  acked: r.acked,
  suspectB: r.suspectB,
  // ⚠️ 这一档**不许写成「已确认」**（第一版就是那个名字，读的人会以为客户端已经收敛）。
  // 判据只是「窗口里出现过一笔带 `ackSession=<本会话>` 的落地写」= **宿主写了凭证**，
  // 与「客户端确认了」之间隔着三件本表看不见的东西：事件有没有到达那一页、那一页的
  // `frames.accept` 有没有把整条载荷丢掉（`docs/pull-ack-investigation.md` 待办第 4 条，
  // 未验证）、以及**发出这条 pull 的是不是同一个页签**——`_ops` 里没有页标识，同会话的
  // 连续 pull 行可能是两个页签各发一次，会被宿主侧的 `pulls=5` 计数串成「一个阶梯跑满」。
  verdict: r.acked > 0 ? '凭证已落地(≠已确认)' : (r.suspectB > 0 ? '疑似 B 无凭证' : '窗口内零凭证'),
})).sort((a, b) => b.pulls - a.pulls);

say(`\n按会话（窗口内；pull 行数≠事件数：同会话连续重复只留 #1 与 pulls=5）`);
say(['会话', 'pull 行', '其中带计数', 'ack 落地', '疑似无凭证写', '归类'].join('\t'));
for (const r of rows) {
  say([r.id.slice(0, 28), r.pulls, r.ladderFull, r.acked, r.suspectB, r.verdict].join('\t'));
}

const byVerdict = {};
for (const r of rows) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + r.pulls;
const total = rows.reduce((n, r) => n + r.pulls, 0);
if (total === 0) {
  say('\n窗口内没有 pull 行 ⇒ 这张表没有载体。等宿主跑出一段新日志再看，不要拿空表下结论。');
  process.exit(0);
}
say('\n占比（按窗口内 pull 行，不是事件数）：');
for (const [v, n] of Object.entries(byVerdict).sort((a, b) => b[1] - a[1])) {
  say(`   ${v.padEnd(16)} ${String(n).padStart(4)} 行 = ${(100 * n / total).toFixed(0)}%`);
}
say('\n读法与边界：');
say('  · 「凭证已落地」只说明**宿主那一侧写到了盘**，不说明客户端确认了（见文件头三条不可见）；');
say('  · 「窗口内零凭证」是**下界**，窗口外的应答看不见；「疑似 B」是时间邻近的启发式归因；');
say('  · 要把这张表升级成「哪条成因占多少」，缺的不是字段而是**页签维度**：`_ops` 里的 pull');
say('    现在不带页标识，两个页签各 pull 同一会话会被宿主的连续计数串成一个阶梯。补');
say('    `page=<id>`（客户端启动时随机、随 op 一起写）之后，阶梯长度、确认与否、来源页三者');
say('    才能对齐——这一条在 `docs/pull-ack-investigation.md` 里是被当作未验证项列出的。');
say(`依据：${REPO}docs/pull-ack-investigation.md 与 ${REPO}scripts/pull-ack-smoke.mjs（六场景 22 组）。`);
process.exit(0);
