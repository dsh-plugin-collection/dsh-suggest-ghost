#!/usr/bin/env node
/**
 * 「HMR 事务内重跑 apply → 用 `hmr.executing.exit` 把建泵那一拍切出事务」的回归。
 *
 * ## 它补的是哪一半
 *
 * `scripts/pump-rearm-smoke.mjs` 验的是**没有逃出手腕**时的兜底：泵被毒化 → 等会话事件
 * 重建。本脚本验的是**有手腕**时的主修复：真实宿主有 `hmr` 服务，
 * `root.get('hmr').executing` 是内核那个 `AsyncLocalStorage`；在 `executing.exit(...)`
 * 里建 `setInterval`，定时器捕获的就是 `store=undefined`，于是**从第一拍起**补写就写得进。
 *
 * 两个脚本合起来才覆盖「`exit` 可用 / 不可用」两代宿主。
 *
 * ## 判据
 *
 * 在事务内 boot，然后**只做一次 pull**（没有会话事件、没有任何即时写成功）。如果
 * 建泵那拍没有被切出事务，pull 应答 / 热度 / `_ops` 清空都会 nested 并被丢弃；
 * 如果切出去了，它们必须在 ~1.5s 内全部落盘。所以「第一次 pull 就成功」本身就是
 * `exit` 生效的证明，不需要去断言私有字段。
 *
 * 用法：`node scripts/pump-hmr-escape-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Context, Service } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { apply as applyHost } from '../lib/index.js';

const NS = 'suggest-ghost';
const SESSION = 'session-escape';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const trace = [];
const realLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.map(String).join(' ');
  trace.push(line);
  if (trace.length > 2000) {
    realLog('[pump-hmr-escape-smoke] 留痕越过 2000 行：紧循环回归，终止。');
    process.exit(99);
  }
};

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

// ── settings 面：事务内 emit ────────────────────────────────────────────────
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
    if (als.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'));
    document = { ...document, ...structuredClone(patch) };
    revision += 1;
    als.run(true, () => this.ctx.emit('settings/document-updated', ns, revision));
    return Promise.resolve();
  }
}

/**
 * 内核的 hmr 服务面：本脚本只用到 `executing.exit`（AsyncLocalStorage 的标准方法）。
 * 真实宿主里 `executing` 是 private 字段，运行时就是 ALS 实例；这里给同形态替身。
 */
class FakeHmr extends Service {
  constructor(ctx) {
    super(ctx, 'hmr');
    this.executing = als;
  }
}

const root = new Context();
if (root.logger === undefined) root.logger = { info() {}, warn() {}, debug() {} };
new SessionStore(root);
const settings = new MemorySettings(root);
new FakeHmr(root);
const session = root.sessions.create(SESSION, { meta: { cwd: process.cwd() } });
session.append('turn/start', { turn: 1 });
session.append('user/message', { content: [{ type: 'text', text: '第一句' }], source: { kind: 'user' } }, { surfaceOp: 'append' });
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });

// 模拟 HMR partialReload：apply 跑在配置写事务里。
als.run(true, () => {
  applyHost(root, {
    maxInputBytes: 4096,
    maxOutputTokens: 512,
    timeoutMs: 1000,
    maxTranscriptChars: 12000,
    maxSuggestionChars: 240,
    llmEnabled: false,
  });
});
await sleep(60);

// 只做一次 pull：没有会话事件、也没有任何即时写成功，恢复只能来自「建泵时已切出事务」。
const before = trace.length;
await settings.update(NS, {
  _ops: JSON.stringify({ rev: 1, ops: [{ op: 'pull', sessionId: SESSION }] }),
});
await sleep(1500);
const window = trace.slice(before);

realLog('\n[escape 窗口] 事务内 boot 后的第一次 pull（无任何恢复事件）：');
for (const line of window) realLog(`  | ${line.slice(0, 200)}`);

run('E1 第一次 pull 的应答就补写成功（无需任何事务外事件恢复）', () => {
  assert.ok(
    window.some((line) => line.includes('deferred push landed')),
    '第一次 pull 没有补写成功：建泵那拍没有被切出事务',
  );
});

run('E2 泵没有被毒化（窗口内没有 deferred-*-nested / 放弃留痕）', () => {
  const poison = window.filter((line) => (
    line.includes('deferred-push-nested')
    || line.includes('deferred hot push refused')
    || line.includes('hot-drain-exhausted')
    || line.includes('giving up: the same context refuses identically')
  ));
  assert.deepEqual(poison, [], `泵仍被 nested 拒：${poison.slice(0, 2).join(' | ')}`);
});

run('E3 pull 应答真的到盘上（历史环含本会话那句话）', () => {
  assert.equal(typeof document._hot, 'string', '盘上没有 _hot 格');
  const hot = JSON.parse(document._hot);
  assert.ok(Array.isArray(hot.history), '_hot.history 不是数组');
  assert.ok(hot.history.includes('第一句'), `历史环内容不对：${JSON.stringify(hot.history)}`);
});

run('E4 _ops 被事务外泵清成 null', () => {
  assert.equal(String(document._ops), 'null', `_ops 仍留在盘上：${String(document._ops).slice(0, 120)}`);
});

run('E5 没有紧循环（窗口留痕有界）', () => {
  assert.ok(window.length <= 40, `窗口留痕 ${window.length} 行 > 40`);
});

console.log = realLog;
if (failures.length > 0) {
  console.error(`\n❌ pump-hmr-escape-smoke: ${cases} 组用例，失败 ${failures.length} 组`);
  process.exit(1);
} else {
  console.log(`\n✅ pump-hmr-escape-smoke: ${cases} 组用例全部通过（留痕 ${trace.length} 行）`);
  process.exit(0);
}
