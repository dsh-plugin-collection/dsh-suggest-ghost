#!/usr/bin/env node
/**
 * `_hot` 饥饿回归（2026-10-22 live 现场，用户报「控制台一直刷」）。
 *
 * ## 现场形态（活锁，两个半环咬在一起）
 *
 * 浏览器页签连着宿主后每 200/400/800…ms 重试 `pull`；宿主每次应答都在事务里被拒
 * ⇒ 排进 `deferred` 的 clearOps 槽。泵每 tick 只补**一个**槽，旧规则「热度格只有
 * 队列空着才轮得到」——而 pull 洪水让 clearOps 槽**永远有下一个** ⇒ `_hot`（应答的
 * 历史环/热度）永远不落地 ⇒ 客户端 `historySessionId` 永远对不上 ⇒ `pendingPull`
 * 判不出「已对账」继续重试 ⇒ 洪水由饥饿本身维持。控制台里刷的就是这条链的
 * `_ops write conflict…` / 客户端 warn 侧。
 *
 * ## 这条脚本的判据（不测「最终会落地」——那测不出饥饿）
 *
 * `hot push landed via deferred pump` 之前，事务外**成功**写了几笔非 `_hot` 的：
 *  - 修复后（pump 写成功的 finally 搭一次 `tryDrainHotPayload` 便车）：**1 笔**
 *    （push1 或 clear1 落地那一刻热度就跟着写）。
 *  - 修复前：≥ **2 笔**（tick1 取 push1 → tick2 取最后一条 pull 应答排的 clearOps →
 *    tick3 队列才空、才轮到热）。所以本脚本用 3 条间隔 150ms 的 pull 把「连续两拍
 *    队列非空」的窗口造出来（洪水的现场节律）。
 * 断言取 `≤1`：它把「搭便车」和「靠空窗运气」分开，不依赖具体 tick 对齐。
 *
 * 用法：`node scripts/hot-starvation-smoke.mjs`（跑编译产物 `lib/index.js`）
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { apply as applyHost } from '../lib/index.js';

const NS = 'suggest-ghost';
const SESSION = 'session-starve';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const trace = [];
// ── 留痕分级（a608e4f #98）之后的捕获修正（#102）────────────────────────────
// 常态留痕自那以后**不再走 console.log**：心跳走 console.debug、状态迁移走 console.info、
// 告警走 console.warn。本脚本靠抓 `[ops-trace]` 文本断言行为 ⇒ 只挂 console.log 会把
// 「打到别的流」误读成「行为坏了」（A2 的 nested 写其实一直在发生，实测 writes 与分级前逐字相同）。
// 所以：① 测试自己把门槛放到 debug（不改生产默认）②捕获面覆盖 debug/info/warn 三条通道。
process.env.DSH_SUGGEST_GHOST_TRACE ??= 'debug';
const realLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.map(String).join(' ');
  trace.push(line);
  if (trace.length > 2000) {
    realLog('[hot-starvation-smoke] 留痕越过 2000 行：紧循环回归。');
    process.exit(99);
  }
};

// 别名指向**已挂钩的** console.log ⇒ 三条通道的留痕都进同一个捕获数组。
const __traceSink = console.log;
console.debug = __traceSink;
console.info = __traceSink;
console.warn = __traceSink;

const als = new AsyncLocalStorage();
let document = {};
let revision = 0;
/** 事务外成功落地的写（时间戳 + patch 键），断言「热落地前挤进去几笔」用。 */
const landed = [];

class MemorySettings extends Service {
  constructor(ctx) {
    super(ctx, 'settings');
  }
  describe() {
    return [{ ns: NS, revision, value: structuredClone(document) }];
  }
  update(ns, patch) {
    if (als.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'));
    // `__injected` 是测试侧标记（替 client 写的 `_ops` 那笔），不落成文档键。
    const injected = patch.__injected === true;
    const clean = { ...patch };
    delete clean.__injected;
    document = { ...document, ...structuredClone(clean) };
    revision += 1;
    landed.push({
      at: Date.now(),
      keys: Object.keys(clean).sort().join(','),
      patch: clean,
      // 「注入」= 测试替 client 写 `_ops` 的那一笔，不是泵的产出，S2 计数必须排除它。
      injected,
    });
    als.run(true, () => this.ctx.emit('settings/document-updated', ns, revision));
    return Promise.resolve();
  }
}

const root = new Context();
if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
new SessionStore(root);
const settings = new MemorySettings(root);
const session = root.sessions.create(SESSION, { meta: { cwd: process.cwd() } });
session.append('turn/start', { turn: 1 });
session.append('user/message', { content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
applyHost(root, {
  maxInputBytes: 4096,
  maxOutputTokens: 512,
  timeoutMs: 1000,
  maxTranscriptChars: 12000,
  maxSuggestionChars: 240,
  llmEnabled: false,
});
await sleep(80);

const pull = (rev) => settings.update(NS, {
  _ops: JSON.stringify({ rev, ops: [{ op: 'pull', sessionId: SESSION }] }),
  __injected: true,
});

// ① pull 风暴（每 150ms 一条，短于泵 500ms 周期 ⇒ 应答写全部落在事务里被拒、
//    clearOps 槽被连续重排；这就是现场的「洪水」侧）。三条给旧代码制造
//    「连续两拍队列非空」的饥饿窗口。
await pull(1);
await sleep(150);
await pull(2);
await sleep(150);
await pull(3);

// ④ 等 `_hot` 经泵落地（有界等待；旧代码这里要 ≥2 拍，仍落在窗口内）。
const hotDeadline = Date.now() + 3000;
let hotLine = undefined;
while (Date.now() < hotDeadline) {
  hotLine = trace.find((line) => line.includes('hot push landed via deferred pump'));
  if (hotLine !== undefined) break;
  await sleep(20);
}

let cases = 0;
const failures = [];
function run(name, fn) {
  cases += 1;
  try {
    fn();
    realLog(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ✗ ${name}\n      ${String(error).split('\n').slice(0, 5).join('\n      ')}`);
  }
}

const hotAt = hotLine === undefined ? undefined : Date.now();
// S3 用：热落地后再给泵两拍，轮询 `_ops` 的终值（run 是同步 try/catch，异步断言
// 必须在主流程里等完，这里只断言已观察到的事实）。
if (hotAt !== undefined) {
  const endDeadline = Date.now() + 1600;
  while (String(document._ops) !== 'null' && Date.now() < endDeadline) await sleep(20);
}

run('S1 `_hot` 最终经事务外泵落地（不是被丢弃）', () => {
  assert.ok(hotLine !== undefined, `3s 内没有 "hot push landed via deferred pump"；留痕尾部：${trace.slice(-3).join(' | ').slice(0, 240)}`);
});

run('S2 搭便车在场：热落地前**至多一笔**非 `_hot` 的写（旧规则要 ≥2）', () => {
  const hotTs = landed.find((w) => w.keys.includes('_hot'));
  assert.ok(hotTs !== undefined, '落地清单里没有 _hot 写');
  const before = landed.filter((w) => w.at < hotTs.at && !w.keys.includes('_hot') && !w.injected);
  assert.ok(
    before.length <= 1,
    `热落地前挤进 ${before.length} 笔非热写（${before.map((w) => w.keys).join(' / ')}）：`
    + '「队列空着才轮到热度」的旧规则又回来了 ⇒ pull 洪水期 `_hot` 饥饿、客户端无限重试',
  );
});

run('S3 风暴后 `_ops` 被清空成 null（活锁的另一半已断）', () => {
  assert.equal(String(document._ops), 'null', `_ops 仍留在盘上：${String(document._ops).slice(0, 80)}`);
});

run('S4 全程留痕有界（无紧循环）', () => {
  assert.ok(trace.length <= 60, `留痕 ${trace.length} 行 > 60`);
});

console.log = realLog;
if (failures.length > 0) {
  console.error(`\n❌ hot-starvation-smoke: ${cases} 组用例，失败 ${failures.length} 组`);
  process.exit(1);
}
realLog(`\n✅ hot-starvation-smoke: ${cases} 组用例全部通过（留痕 ${trace.length} 行；成功写 ${landed.length} 笔）`);
process.exit(0);
