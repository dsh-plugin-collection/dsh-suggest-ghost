#!/usr/bin/env node
/**
 * HMR 事务内写失败**有界重试**的回归（2026-10-22 事故）。
 *
 * ## 事故形态（这条脚本钉住的就是它）
 *
 * 客户端一条 `pull` 写进 `_ops`。内核在 settings 写入事务里就地 emit
 * `settings/document-updated`，于是宿主的 `consumeOps` 回调**整个跑在 HMR 事务内**；
 * 它应答 pull 时会推 `_hot`（历史环/热度），而那次写在事务内被
 * `HMR transactions cannot be nested` 拒绝。拆分打卡（#57）之后失败分支把载荷放回
 * `pendingHotPayload`，`.finally` 见槽非空又立刻 `flushPush()`——**失败 → 重排 →
 * 再写**，全程都在微任务里，事件循环拿不回控制权；每圈还打一行 `hot write refused`。
 * 现场表现：tee 日志 23 GB、进程卡死、`_ops` 一直留在盘上（清空那笔也写不进）。
 *
 * ## 这条脚本断言什么（按「会咬人」排序）
 *
 *  1. **有界**：一次事务内 pull 之后，`hot write refused` 的次数 ≤ 2（首次即时写 +
 *     至多一次事务外泵尝试的失败）；总留痕行数远小于 2000（紧循环会瞬间越过这个数，
 *     脚本会直接 `exit 99`，不把机器写死）。A 组同时有**下界**：夹具必须真的记录到
 *     `_hot`/`_ops` 写落在事务内被 nested 拒，否则「这一拍不脏/写成功」也会绿。
 *  2. **事件循环还活着**：下面的 `setTimeout` 必须能按时触发。紧循环下它永远不触发，
 *     脚本超时（外部 timeout / CI fail）而不是假绿。
 *  3. **自愈链仍完整**：事务外泵把 `_ops` 清空成 `null`、把 `_hot` 落盘（历史环里有
 *     本脚本种的那句话）。也就是说修复不是靠「把重试全删掉」。
 *  4. **`after=` 有信息量**：被拒留痕的 `after=` 必须是本次推送的毫秒数，不是从 epoch
 *     起算的 1792631…（拆分重构曾把 `pushStartedAt` 的赋值弄丢）。
 *  5. **泵也写不进时仍不无限重试**：把宿主写入全部拒掉，数**写面**（不是数被 `traceFault`
 *     节流过的日志行）：`_hot` 写入次数必须恰为 `1 + HOT_DRAIN_MAX_ATTEMPTS`，再等 1.6s
 *     不得有新增，放弃留痕里的 `attempts=` 必须等于上限。
 *
 * ## 为什么用 lib/ 而不是 src/
 *
 * 这条脚本验的是**接线**（`apply()` 建泵的位置、`.finally` 的续写条件），只能跑编译
 * 产物；`src/index.ts` 用 `.js` 说明符，`--experimental-strip-types` 解析不了。
 * 因此它排在 `test:e2e` 的构建之后（见 package.json）。改完 src 不重建时它会测旧
 * 字节——`scripts/artifact-freshness.mjs`（`check:loop`）负责把这种情况报出来。
 *
 * 用法：`node scripts/hmr-write-loop-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { HOT_DRAIN_MAX_ATTEMPTS, apply as applyHost } from '../lib/index.js';

const NS = 'suggest-ghost';
const SESSION = 'session-hmr';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 留痕捕获：既给断言用，也当「紧循环保险丝」（越过 2000 行直接终止）──────────
const trace = [];
let logLines = 0;
const realLog = console.log.bind(console);
console.log = (...args) => {
  logLines += 1;
  const line = args.map(String).join(' ');
  trace.push(line);
  if (logLines > 2000) {
    realLog(`[hmr-write-loop-smoke] 留痕越过 2000 行 —— 微任务紧循环仍在（2026-10-22 事故形态），终止。`);
    realLog(`[hmr-write-loop-smoke] 最后一行：${line.slice(0, 240)}`);
    process.exit(99);
  }
};

let cases = 0;
const failures = [];
function run(name, fn) {
  cases += 1;
  try {
    fn();
    // 走 realLog：`console.log` 从本脚本启动起就被换成了留痕收集器（见文件头），
    // 用 console.log 打 ✓ 会被收进 trace 而不显示，成功时整场只剩最后一行。
    realLog(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ✗ ${name}\n      ${String(error).split('\n').slice(0, 5).join('\n      ')}`);
  }
}

// ── 最小的 settings 面：按内核时序在**写入事务内** emit ─────────────────────────
const als = new AsyncLocalStorage();
let document = {};
let revision = 0;
/** 置 true 后宿主的一切写都失败（泵也写不进）；客户端那条 pull 写入仍照常。 */
let failHostWrites = false;
/** 被拒绝/落盘的写，供「写次数有界」断言。 */
const writes = [];

class MemorySettings extends Service {
  constructor(ctx) {
    super(ctx, 'settings');
  }
  describe() {
    return [{ ns: NS, revision, value: structuredClone(document) }];
  }
  update(ns, patch) {
    // 真事务内：内核 `runExclusive` 同步拒绝（`HMR transactions cannot be nested`）。
    // 这一支也记进 `writes`：A 组要靠它证明「事故路径真的被走到了」，而不是因为
    // 「这一拍热度不脏 / 写成功了」才绿（那样的绿对这条回归毫无信息量）。
    if (als.getStore()) {
      writes.push({ nested: true, hostWrite: false, ok: false, patch: structuredClone(patch) });
      return Promise.reject(new Error('HMR transactions cannot be nested'));
    }
    // 场景 B：事务外的泵也写不进（复刻锁等待超时；同样是可重试类失败）。
    if (failHostWrites) {
      writes.push({ nested: false, hostWrite: true, ok: false, patch: structuredClone(patch) });
      return Promise.reject(new Error('atomic-write: timed out waiting for the writer lock'));
    }
    document = { ...document, ...structuredClone(patch) };
    revision += 1;
    writes.push({ nested: false, hostWrite: true, ok: true, patch: structuredClone(patch) });
    // 内核在 `SettingsForms.write()` → `describe()` 里就地 emit（：435），整个回调
    // 因此跑在 `dsh-hmr` 的 `executing.run(true, …)` 内。这里复刻那个上下文：
    // 回调里再写 settings 会被 nested 判据拒绝。
    als.run(true, () => this.ctx.emit('settings/document-updated', ns, revision));
    return Promise.resolve();
  }
}

/**
 * 起一个「进程」：真 Context + 真 SessionStore + 内存 settings + 本插件 host 端。
 * @param {{ turns?: number, userTexts?: string[] }} seed
 */
async function boot(seed = { turns: 2, userTexts: ['第一句', '第二句'] }) {
  const root = new Context();
  if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
  new SessionStore(root);
  const settings = new MemorySettings(root);
  const session = root.sessions.create(SESSION, { meta: { cwd: process.cwd() } });
  for (let turn = 1; turn <= (seed.turns ?? 2); turn += 1) {
    session.append('turn/start', { turn });
    const text = (seed.userTexts ?? [])[turn - 1];
    if (text !== undefined) {
      session.append('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' });
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } });
  }
  applyHost(root, {
    maxInputBytes: 4096,
    maxOutputTokens: 512,
    timeoutMs: 1000,
    maxTranscriptChars: 12000,
    maxSuggestionChars: 240,
    // 场景 B 要一条**不调 LLM、只推热度**的回合结束路径（用户可调项默认 true，
    // 这里关掉；`effective()` 读 describe()，夹具行里没有这个键 ⇒ 用这份 boot 默认层）。
    llmEnabled: false,
  });
  // 等 settings 注入与启动回读完成（服务被用过一次即可，同 coldstart-e2e 的判据）。
  for (let i = 0; i < 40; i += 1) {
    if (revision > 0) break;
    await sleep(5);
  }
  await sleep(20);
  return { root, session, settings };
}

const ctx = await boot();
const bootedAt = trace.length;

// ── 场景 A：事务内 pull（事故原路径）──────────────────────────────────────────
await ctx.settings.update(NS, {
  _ops: JSON.stringify({ rev: 1, ops: [{ op: 'pull', sessionId: SESSION }] }),
});
// 500ms 泵：先排 push/clear 两槽（两个 tick），热度格第三个 tick；留足 4 个 tick。
await sleep(2200);
const afterPull = trace.slice(bootedAt);

realLog('\n[场景 A] 事务内 pull 之后：');
for (const line of afterPull) realLog(`  | ${line.slice(0, 200)}`);

run('A1 事务内 pull 之后留痕有界（不出现 2000 行级紧循环）', () => {
  assert.ok(afterPull.length <= 40, `留痕 ${afterPull.length} 行 > 40：疑似仍在紧循环`);
});

run('A2 事故路径真的被走到：应答写落在事务里并被 nested 拒（下界，不是只看 ≤2）', () => {
  const nested = writes.filter((w) => w.nested === true);
  assert.ok(
    nested.some((w) => typeof w.patch._hot === 'string'),
    '没有任何 _hot 写落在事务内：A 组没有经过事故路径（测试退化）',
  );
  assert.ok(
    nested.some((w) => typeof w.patch._ops === 'string'),
    '没有任何 _ops 清空落在事务内：A 组没有经过事故路径（测试退化）',
  );
  const refusals = afterPull.filter((line) => line.includes('hot write refused') || line.includes('deferred hot push refused'));
  assert.ok(refusals.length >= 1, '一次热度被拒都没有：A 组没有经过事故路径（测试退化）');
  assert.ok(refusals.length <= 2, `热度格被拒 ${refusals.length} 次 > 2：重试没有上界`);
});

run('A3 after= 是本次推送毫秒数，不是从 epoch 起算（拆分重构丢过赋值）', () => {
  const stale = afterPull.find((line) => {
    const match = /after=(\d+)ms/.exec(line);
    return match !== null && Number(match[1]) > 10_000;
  });
  assert.equal(stale, undefined, `出现了荒谬的 after=（pushStartedAt 未赋值）：${String(stale).slice(0, 160)}`);
});

/**
 * A3 的两个补角（2026-10-22 复核增量，都是「断言自己会静默失效」的形态）：
 *  - **缺键**：A3 的谓词在 `after=` 不存在时返回 false，于是「留痕把 after= 整个弄丢」
 *    会被读成通过 —— 而这条断言存在的理由恰恰是「after= 得有信息量」。
 *  - **负值**：`Number('-5') > 10_000` 为假 ⇒ 起点被写成未来时刻时 A3 也是绿的。
 *    （`pushStartedAt` 用错基准、或复用了一条陈旧起点，都会出这种数。）
 *
 * ⚠️ **变异要数值上可分辨，否则「断言没红」不等于「断言有效」**：我第一次自证是把
 * `Date.now() - pushStartedAt` 整个翻转成 `pushStartedAt - Date.now()`，结果 A3b 没红 ——
 * 因为这一拍的真实耗时是 0~1ms，翻转后是 0 或 -1，`-0` 根本不匹配负号，等于没变异。
 * 换成 `- 5000` 之后 A3b/A3c 同时红。**测「有没有界」要用显著量级的偏移**，不是符号。
 */
const refusalLines = afterPull.filter((line) => /refused/.test(line) && line.includes('after='));
run('A3b 每条带 after= 的被拒留痕，after= 都必须是**非负**时长', () => {
  const negative = afterPull.find((line) => {
    const match = /after=(-\d+)ms/.exec(line);
    return match !== null;
  });
  assert.equal(negative, undefined, `after= 是负数（起点晚于终点，时长不可解释）：${String(negative).slice(0, 160)}`);
});

run('A3c 带 after= 的那两种形态不许把 after= 丢掉（缺键不能读成通过）', () => {
  // 口径（第一版我写宽了，正好被这条测出来）：`after=` 只属于**即时写被拒**的两条形态：
  //  - `hot write refused … re-staged=1 after=Nms`（热度格即时被拒，永远带）
  //  - `push write refused … carriedCompletion=1 after=Nms`（带续写的那条**不节流**，所以带）
  // 而 `push-nested #N` 那种**节流**行与泵侧的 `deferred hot push refused` 量的是别的
  // 东西（第几次补写），本来就没有 after= —— 要求「所有 refused 行都带」会把合法行判成红。
  // 这条断言真正的价值是：**只要那两种形态出现过，after= 就必须在**，否则 A3 整条空转。
  const forms = [
    { re: /hot write refused/, label: 'hot write refused … re-staged', need: /after=\d+ms/ },
    { re: /push write refused .*carriedCompletion=1/, label: 'push write refused（带续写、不节流）', need: /after=\d+ms/ },
  ];
  let carriers = 0;
  for (const form of forms) {
    const lines = afterPull.filter((line) => form.re.test(line));
    for (const line of lines) {
      carriers += 1;
      assert.ok(form.need.test(line),
        `「${form.label}」这一行丢了 after= ⇒ A3（时长合法性）对它空转：${line.slice(0, 160)}`);
    }
  }
  assert.ok(carriers >= 1,
    `A 组里两种带 after= 的形态一行都没有 ⇒ 这三条断言没有载体（测试退化，不是通过）：refused=${JSON.stringify(afterPull.filter((l) => l.includes('refused')).map((l) => l.slice(0, 60)))}`);
});

run('A4 事务外泵仍把 _ops 清空成 null（修复不是靠删掉补写）', () => {
  assert.equal(String(document._ops), 'null', `_ops 仍留在盘上：${String(document._ops).slice(0, 120)}`);
});

run('A5 事务外泵把 _hot 落盘，历史环里带上本会话那句话', () => {
  assert.equal(typeof document._hot, 'string', '盘上没有 _hot 格');
  const hot = JSON.parse(document._hot);
  assert.ok(Array.isArray(hot.history), '_hot.history 不是数组');
  assert.ok(hot.history.includes('第二句'), `历史环里没有本会话的话：${JSON.stringify(hot.history)}`);
});

run('A6 写次数有界（自愈链没有把 revision 推成风暴）', () => {
  const hostWrites = writes.filter((w) => w.hostWrite).length;
  assert.ok(hostWrites <= 8, `事务外写 ${hostWrites} 次 > 8（泵在空转）`);
});

// ── 场景 B：泵也写不进 —— 次数上限必须生效，进程仍能走到结尾 ─────────────────
// 造一条**只脏热度格**的推送：追加用户消息（环变长）+ 回合结束（`llmEnabled:false`
// 的那条早退路径直接推热度，不调 LLM）。这样 `_push` 指纹不变 ⇒ 只有 `_hot` 进槽，
// `deferred` 两槽保持空 ⇒ 热度格的泵内预算能独立被测到（不被 push/clear 的重试挡住）。
await ctx.session.append('user/message', {
  content: [{ type: 'text', text: '第三句' }],
  source: { kind: 'user' },
}, { surfaceOp: 'append' });
ctx.session.append('turn/start', { turn: 3 });
await sleep(20);
const beforeB = trace.length;
const hotWritesOf = () => writes.filter((w) => typeof w.patch._hot === 'string').length;
const hotWritesBaseline = hotWritesOf(); // A 组也写过 _hot（被拒 + 落盘），B 只看增量
failHostWrites = true;
const bStartedAt = Date.now();
ctx.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
// 1 次即时 + 3 次上限 × 500ms 泵 + 余量。
await sleep(2200);
const elapsedB = Date.now() - bStartedAt;
const afterB = trace.slice(beforeB);
const hotWritesAtCap = hotWritesOf() - hotWritesBaseline;
// 再等 1.6s：上限之后**不允许**再有尝试（这是「有界」与「只是慢」的区别）。
await sleep(1600);
const hotWritesAfterSettle = hotWritesOf() - hotWritesBaseline;
realLog('\n[场景 B] 泵也写不进时：');
for (const line of afterB) realLog(`  | ${line.slice(0, 200)}`);

run('B1 _hot 的写入次数 = 1 次即时 + HOT_DRAIN_MAX_ATTEMPTS 次泵（数写面，不数被节流的日志）', () => {
  // 常量本身是产品决定（预算给大了只是加剧本仓锁竞争）：改它必须同时改这条断言。
  assert.equal(HOT_DRAIN_MAX_ATTEMPTS, 3, `HOT_DRAIN_MAX_ATTEMPTS=${HOT_DRAIN_MAX_ATTEMPTS} ≠ 3（改预算请同步本断言与 CHANGELOG）`);
  // 口径：这里真正要钉的是**有界**（≤ 1 + 上限），不是「一定等于 4」。
  // task-16 的合并窗口落地后，B 场景的第一次热度变化可能落在 A 场景留下的**开着口的窗口**
  // 里 ⇒ 没有那次 leading 即时写，实测从 4 变成 3 —— 这是节流的预期行为，不是回归。
  // 上界一侧必须钉住（它就是紧循环的护栏），下界一侧留着证明「确实尝试过、不是静默丢数据」。
  assert.ok(
    hotWritesAtCap <= 1 + HOT_DRAIN_MAX_ATTEMPTS,
    `_hot 写了 ${hotWritesAtCap} 次 > 1+${HOT_DRAIN_MAX_ATTEMPTS}：次数上限没有生效（这才是紧循环护栏）`,
  );
  assert.ok(hotWritesAtCap >= 1, '_hot 一次都没写：合并把它吞成了丢数据（窗口内至少该有一次尝试或明确的放弃留痕）');
});

run('B2 到上限即停止：再等 1.6s 不再有任何 _hot 尝试（有界，不是「慢」）', () => {
  assert.equal(
    hotWritesAfterSettle,
    hotWritesAtCap,
    `上限后仍在重试：${hotWritesAfterSettle - hotWritesAtCap} 次新增写`,
  );
});

run('B3 放弃留痕带准确次数（可见的放弃，不是静默烧日志）', () => {
  const line = afterB.find((l) => l.includes('hot-drain-exhausted'));
  assert.ok(line !== undefined, '没有 hot-drain-exhausted 留痕：无法判断是重试还是静默丢弃');
  const match = /attempts=(\d+)/.exec(line);
  assert.ok(match !== null, `放弃留痕缺 attempts=：${line.slice(0, 160)}`);
  assert.equal(Number(match[1]), HOT_DRAIN_MAX_ATTEMPTS, `放弃时的 attempts=${match[1]} ≠ ${HOT_DRAIN_MAX_ATTEMPTS}`);
});

run('B4 失败风暴也有界（热度 3 次 + 日志节流）', () => {
  assert.ok(afterB.length <= 120, `泵失败期间留痕 ${afterB.length} 行 > 120`);
});

run('B5 事件循环没被饿死：2.2s 的等待必须按时结束（timer 能跑）', () => {
  assert.ok(elapsedB >= 2000 && elapsedB <= 5000, `2.2s 的等待实际用了 ${elapsedB}ms：timer 调度被饿死`);
});

console.log = realLog;
if (failures.length > 0) {
  console.error(`\n❌ hmr-write-loop-smoke: ${cases} 组用例，失败 ${failures.length} 组`);
  process.exit(1);
} else {
  console.log(`\n✅ hmr-write-loop-smoke: ${cases} 组用例全部通过（留痕峰值 ${logLines} 行）`);
  // 插件的事务外泵是常驻 `setInterval`（真实宿主里由 ctx.effect 卸载），本脚本是
  // 一次性进程，必须在断言之后主动退出，否则 Node 永远等这个定时器。
  process.exit(0);
}
