#!/usr/bin/env node
/**
 * 「泵被 HMR 事务毒化 → 从会话事件恢复到事务外」的回归（2026-10-22 现场，0.7.1）。
 *
 * ## 现场形态
 *
 * 插件被 HMR `partialReload` **在配置写入事务内**重新 `apply()`。`apply()` 里建的
 * `setInterval` 继承当时的 `AsyncLocalStorage`（`store=true`），此后补写泵的每一笔写
 * 都被 `HMR transactions cannot be nested` 拒绝：
 *
 * ```
 * deferred push write refused again in the apply()-time pump (... nested ...)
 * deferred hot push dropped reason=attempts-exhausted ...
 * ```
 *
 * 后果不是日志（有界重试已经把量限住），而是**功能全断**：pull 应答、续写、`_ops`
 * 清空全补不进去。客户端因为拿不到应答而反复重发 pull，`_ops` 写入本身成功、revision
 * 一路涨；再叠加客户端并发的 complete 写，就出现用户看到的
 * `_ops write conflict retries exhausted` 与 `completion not shown`。
 *
 * ## 这条脚本钉住的两件事
 *
 *  1. **毒化能被识别**：在事务内 boot 之后，泵写确实拿到 nested 拒绝（不是静默丢弃）。
 *  2. **能在事务外恢复**：会话事件（不继承配置事务）触发 `rearmDeferredPump()`，
 *     之后**同一进程**里的补写必须落盘——pull 应答的 `_push`、`_hot`、以及 `_ops`
 *     清空都要真的写进去。只验「日志里出现了 re-armed」不算通过。
 *
 * ## 为什么用 lib/
 *
 * 验的是 `apply()` 建泵的上下文与事件接线，只能跑编译产物（`src/index.ts` 用 `.js`
 * 说明符，strip-types 解析不了）。排在 `test:e2e` 的构建之后，见 package.json。
 *
 * 用法：`node scripts/pump-rearm-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { apply as applyHost } from '../lib/index.js';

const NS = 'suggest-ghost';
const SESSION = 'session-rearm';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 留痕捕获 + 紧循环保险丝（本场景不该再出现紧循环；越界说明修好的东西又坏了）。
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
    realLog('[pump-rearm-smoke] 留痕越过 2000 行：紧循环回归，终止。');
    realLog(`[pump-rearm-smoke] 最后一行：${line.slice(0, 240)}`);
    process.exit(99);
  }
};

// 别名指向**已挂钩的** console.log ⇒ 三条通道的留痕都进同一个捕获数组。
const __traceSink = console.log;
console.debug = __traceSink;
console.info = __traceSink;
console.warn = __traceSink;

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

// ── 最小 settings 面：写入时在事务内 emit；泵的上下文由建定时器时的 ALS 决定 ──────
const als = new AsyncLocalStorage();
let document = {};
let revision = 0;

class MemorySettings extends Service {
  constructor(ctx) {
    super(ctx, 'settings');
  }
  describe() {
    return [{ ns: NS, revision, value: structuredClone(document) }];
  }
  update(ns, patch) {
    // 事务内（含 HMR partialReload 重跑 apply 时建泵的那段）一律拒绝嵌套写，
    // 与内核 `runExclusive` 的判据同形。
    if (als.getStore()) {
      return Promise.reject(new Error('HMR transactions cannot be nested'));
    }
    document = { ...document, ...structuredClone(patch) };
    revision += 1;
    // 内核在 `SettingsForms.write()` → `describe()` 里就地 emit（`dsh-settings` :435），
    // 所以 is 回调跑在写事务内。
    als.run(true, () => this.ctx.emit('settings/document-updated', ns, revision));
    return Promise.resolve();
  }
}

// ── 在事务内 boot（模拟 HMR partialReload）────────────────────────────────────
const root = new Context();
if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
new SessionStore(root);
const settings = new MemorySettings(root);
const session = root.sessions.create(SESSION, { meta: { cwd: process.cwd() } });
session.append('turn/start', { turn: 1 });
session.append('user/message', { content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

als.run(true, () => {
  applyHost(root, {
    maxInputBytes: 4096,
    maxOutputTokens: 512,
    timeoutMs: 1000,
    maxTranscriptChars: 12000,
    maxSuggestionChars: 240,
    // 不要在本脚本里触发 LLM 生成：这条只验补写通道。
    llmEnabled: false,
  });
});
await sleep(60);

const linesWith = (needle) => trace.filter((line) => line.includes(needle));
const pull = (rev) => settings.update(NS, {
  _ops: JSON.stringify({ rev, ops: [{ op: 'pull', sessionId: SESSION }] }),
});

// ── 毒化：事务内 boot 后的第一轮 pull，泵写的两槽都会 nested ─────────────────────
const beforeFirst = trace.length;
await pull(1);
await sleep(1400); // 2 次 push 尝试 + 热度格 3 次尝试的窗口
const firstWindow = trace.slice(beforeFirst);

realLog('\n[毒化窗口] 事务内 boot 后的第一轮 pull：');
for (const line of firstWindow) realLog(`  | ${line.slice(0, 200)}`);

run('C1 事务内 boot 的泵确实被毒化（泵写拿到 nested 拒绝，不是静默丢）', () => {
  const poison = firstWindow.filter((line) => (
    line.includes('deferred-push-nested') || line.includes('deferred hot push')
    || line.includes('apply()-time pump')
  ));
  assert.ok(poison.length >= 1, '第一轮窗口里没有任何「泵被 nested 拒」的留痕：夹具没有复刻事故');
});

run('C2 毒化窗口内没有补写侥幸成功（否则测不出恢复）', () => {
  assert.equal(linesWith('deferred push landed').length, 0, '毒化窗口里居然有 deferred push landed');
});

// ── 恢复：会话事件不继承配置事务，泵在这里重建 ───────────────────────────────
const beforeRearm = trace.length;
// user/message 不触发 LLM 生成（llmEnabled=false 时 turn/end 才推热度），只走事件接线。
session.append('user/message', { content: [{ type: 'text', text: '第二句' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
await sleep(50);
const rearmLines = trace.slice(beforeRearm).filter((line) => line.includes('deferred pump re-armed'));

run('C3 会话事件触发事务外重建（re-armed 留痕在场）', () => {
  assert.equal(rearmLines.length, 1, `re-armed 留痕 ${rearmLines.length} 条（应为 1）`);
});

// ── 恢复后的下一轮 pull：补写必须真的落盘 ───────────────────────────────────
const beforeSecond = trace.length;
await pull(2);
await sleep(1600);
const secondWindow = trace.slice(beforeSecond);

realLog('\n[恢复窗口] 重建后的第二轮 pull：');
for (const line of secondWindow) realLog(`  | ${line.slice(0, 200)}`);

run('C4 重建后的泵写成功：deferred push landed 出现', () => {
  assert.ok(
    secondWindow.some((line) => line.includes('deferred push landed')),
    '重建后仍没有补写成功：rearm 只是换了个定时器，没有换上下文',
  );
});

run('C5 恢复后的 pull 应答真的到了盘上（历史环含本会话两句话）', () => {
  assert.equal(typeof document._hot, 'string', '盘上没有 _hot 格');
  const hot = JSON.parse(document._hot);
  assert.ok(Array.isArray(hot.history), '_hot.history 不是数组');
  assert.ok(hot.history.includes('第二句'), `历史环没更新：${JSON.stringify(hot.history)}`);
});

run('C6 恢复后 _ops 被事务外泵清成 null（清空通道也活着）', () => {
  assert.equal(String(document._ops), 'null', `_ops 仍留在盘上：${String(document._ops).slice(0, 120)}`);
});

run('C7 恢复后没有紧循环（总留痕远小于保险丝）', () => {
  assert.ok(secondWindow.length <= 40, `恢复窗口留痕 ${secondWindow.length} 行 > 40：疑似紧循环`);
});

console.log = realLog;
if (failures.length > 0) {
  console.error(`\n❌ pump-rearm-smoke: ${cases} 组用例，失败 ${failures.length} 组`);
  process.exit(1);
} else {
  console.log(`\n✅ pump-rearm-smoke: ${cases} 组用例全部通过（留痕 ${trace.length} 行）`);
  process.exit(0);
}
