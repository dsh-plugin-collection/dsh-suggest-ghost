#!/usr/bin/env node
/**
 * 写失败的**三态分诊** + 补写泵与即时写**互斥**的冒烟测试。
 *
 * 保的是四组会咬人的性质：
 *  1. **分诊三态**（纯函数，`src/deferred-writes.ts` 的 `triageWriteFailure`）：
 *     结构性拒绝（`HMR transactions cannot be nested`）、可重试的竞争失败
 *     （`atomic-write: timed out waiting for the writer lock`）、未识别的失败——三者
 *     必须落到**不同的 kind**，否则「哪种失败吃掉了几次」不可统计（老实现只有一条
 *     `/cannot be nested/` 正则兜着，锁超时被归进终局丢弃那一支）。
 *  2. **处置**（真实分诊 + 真实队列）：两类可重试的**必须进补写队列**（不得终局丢弃：
 *     丢弃＝载荷凭空消失、client 收不到幽灵）；未识别的**必须丢弃但留痕**，且留痕要说
 *     清是「未知」而不是伪装成前两者。
 *  3. **泵内重试**：锁超时在补写泵里再失败时，那一项**必须回到槽里**（能重试到成），
 *     而结构性拒绝在同一个上下文里再试也是同一个错（所以至多再试一次就放弃）。
 *  4. **互斥**：补写泵在即时写还在途时**不抢锁**（抢锁＝
 *     `atomic-write: timed out waiting for the writer lock`），并且等锁时长**留痕**
 *     （`deferred-wait` + `waitedMs`）；排队期间**不放指纹**，所以同一份内容的后续
 *     推送不会重复走那条注定被拒的即时写。
 *
 * 前三组是**行为**（纯函数 + 真实队列，可离线驱动）；第四组里「接线」部分是**静态
 * 守卫**（只查代码）：分诊、分支、kind、互斥检查点都在 `src/index.ts` 里，位置错了
 * 上面那些断言全绿、端到端却静默退回今天的行为。与
 * `scripts/deferred-writes-smoke.mjs` 同一手法（注释里出现旧写法是文档，不算回归）。
 *
 * 用法：node --experimental-strip-types scripts/push-failure-triage-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DeferredWriteQueue,
  errorText,
  isStructuralRefusal,
  isWriterLockTimeout,
  triageWriteFailure,
} from '../src/deferred-writes.ts';

let cases = 0;
const run = (name, fn) => {
  cases += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n      ${String(error).split('\n').slice(0, 4).join('\n      ')}`);
    process.exitCode = 1;
  }
};

// ── 三种失败的真实报文 ────────────────────────────────────────────────────────────
/** 结构性拒绝：内核 `runExclusive` 在事务内嵌套时的同步拒绝。 */
const NESTED_ERROR = new Error('HMR transactions cannot be nested');
/** 可重试的竞争失败：写锁等待超时（原文照抄 `dsh-atomic-write` 的抛出点）。 */
const LOCK_TIMEOUT_ERROR = new Error(
  'atomic-write: timed out waiting for the writer lock at /home/u/.dsh/profiles/web/package.json',
);
/** 未识别的失败：不在已知两类里。 */
const UNKNOWN_ERROR = new Error('boom: something nobody has classified yet');

// ── 1. 分诊：三态 + 三个不同的 kind ───────────────────────────────────────────────
run('结构性拒绝 → structural-refusal，处置=进队列，kind=push-nested', () => {
  const triage = triageWriteFailure(NESTED_ERROR, 'push');
  assert.equal(triage.cls, 'structural-refusal');
  assert.equal(triage.disposition, 'queue');
  assert.equal(triage.kind, 'push-nested');
  assert.equal(triage.suffix, 'nested');
});

run('写锁等待超时 → retryable-contention，处置=进队列，kind=push-lock-timeout', () => {
  const triage = triageWriteFailure(LOCK_TIMEOUT_ERROR, 'push');
  assert.equal(triage.cls, 'retryable-contention');
  assert.equal(triage.disposition, 'queue');
  assert.equal(triage.kind, 'push-lock-timeout');
  assert.equal(triage.suffix, 'lock-timeout');
});

run('未识别的失败 → unknown，处置=丢弃，kind=push-failed，留痕说清是「未知」', () => {
  const triage = triageWriteFailure(UNKNOWN_ERROR, 'push');
  assert.equal(triage.cls, 'unknown');
  assert.equal(triage.disposition, 'drop');
  assert.equal(triage.kind, 'push-failed');
  assert.match(triage.label, /unknown/i, '未知类的留痕必须说清是未知，不许伪装成前两者');
});

run('两类的 kind 必须不同（否则「哪种失败吃掉了几次」不可统计）', () => {
  const nested = triageWriteFailure(NESTED_ERROR, 'push');
  const lock = triageWriteFailure(LOCK_TIMEOUT_ERROR, 'push');
  assert.notEqual(nested.kind, lock.kind);
  assert.notEqual(nested.kind, triageWriteFailure(UNKNOWN_ERROR, 'push').kind);
  assert.notEqual(lock.kind, triageWriteFailure(UNKNOWN_ERROR, 'push').kind);
});

run('_ops 清空通道同样三态、三个不同的 kind（不复用 push 的 kind）', () => {
  const kinds = [NESTED_ERROR, LOCK_TIMEOUT_ERROR, UNKNOWN_ERROR]
    .map((error) => triageWriteFailure(error, 'clearOps').kind);
  assert.deepEqual(kinds, ['ops-clear-nested', 'ops-clear-lock-timeout', 'ops-clear-failed']);
  assert.equal(new Set(kinds).size, 3);
});

run('泵内重试路径的 kind 也按类别分开（deferred-* 不共用一个计数器）', () => {
  const kinds = [NESTED_ERROR, LOCK_TIMEOUT_ERROR, UNKNOWN_ERROR]
    .map((error) => triageWriteFailure(error, 'push').deferredKind);
  assert.deepEqual(kinds, ['deferred-push-nested', 'deferred-push-lock-timeout', 'deferred-push-failed']);
  assert.equal(new Set(kinds).size, 3);
});

run('两种可重试的都不许被归成 unknown（老实现的漏网之处）', () => {
  assert.notEqual(triageWriteFailure(LOCK_TIMEOUT_ERROR, 'push').cls, 'unknown');
  assert.notEqual(triageWriteFailure(NESTED_ERROR, 'push').cls, 'unknown');
  assert.notEqual(triageWriteFailure(LOCK_TIMEOUT_ERROR, 'push').cls, 'structural-refusal');
  assert.notEqual(triageWriteFailure(NESTED_ERROR, 'push').cls, 'retryable-contention');
});

run('报文判据互不串味：nested 不算锁超时、锁超时不算 nested', () => {
  assert.equal(isStructuralRefusal(NESTED_ERROR.message), true);
  assert.equal(isWriterLockTimeout(NESTED_ERROR.message), false);
  assert.equal(isWriterLockTimeout(LOCK_TIMEOUT_ERROR.message), true);
  assert.equal(isStructuralRefusal(LOCK_TIMEOUT_ERROR.message), false);
  assert.equal(isWriterLockTimeout(UNKNOWN_ERROR.message), false);
});

run('抛的不是 Error 实例但带 message 时也认得出来（否则退化成 [object Object] → 误判未知）', () => {
  const asObject = { message: LOCK_TIMEOUT_ERROR.message };
  assert.equal(triageWriteFailure(asObject, 'push').cls, 'retryable-contention');
  assert.equal(triageWriteFailure(LOCK_TIMEOUT_ERROR.message, 'push').cls, 'retryable-contention');
  assert.equal(errorText(asObject), LOCK_TIMEOUT_ERROR.message);
  assert.equal(errorText(new Error('x')), 'x');
  assert.equal(errorText('x'), 'x');
});

// ── 2. 处置：可重试的进队列，未知的丢弃 ────────────────────────────────────────────
/**
 * 按 `src/index.ts` 的接线复刻的处置模型：分诊 → 排队 or 丢弃。
 *
 * 复刻的是**处置形状**（用真实分诊 + 真实队列）；接线本身由第 4 组的静态守卫钉住。
 */
const handleWriteFailure = (queue, error, payload) => {
  const triage = triageWriteFailure(error, 'push');
  if (triage.disposition === 'queue') {
    queue.enqueuePush({ payload, fingerprint: 'fp1', carriesCompletion: true }, 1000);
  }
  return triage;
};

run('结构性拒绝 → 进补写队列（载荷留在槽里等事务外补写）', () => {
  const queue = new DeferredWriteQueue();
  const triage = handleWriteFailure(queue, NESTED_ERROR, 'PAYLOAD');
  assert.equal(triage.disposition, 'queue');
  assert.equal(queue.size, 1, '被拒的载荷必须进队列，不得终局丢弃');
  assert.equal(queue.take().payload, 'PAYLOAD');
});

run('写锁等待超时 → 进补写队列（**不得**终局丢弃：丢弃＝载荷凭空消失）', () => {
  const queue = new DeferredWriteQueue();
  const triage = handleWriteFailure(queue, LOCK_TIMEOUT_ERROR, 'PAYLOAD');
  assert.equal(triage.disposition, 'queue');
  assert.equal(queue.size, 1, '锁超时是可重试的竞争失败，必须排队而不是丢弃');
  assert.equal(queue.take().payload, 'PAYLOAD');
});

run('未识别的失败 → 不进队列（保持丢弃），但必须留痕且留痕说清是「未知」', () => {
  const queue = new DeferredWriteQueue();
  const triage = handleWriteFailure(queue, UNKNOWN_ERROR, 'PAYLOAD');
  assert.equal(triage.disposition, 'drop');
  assert.equal(queue.size, 0, '未知类不进队列');
  assert.match(triage.label, /unknown/i);
  assert.equal(triage.kind, 'push-failed');
});

run('锁超时在泵里再失败 → 那一项回到槽里（能重试到成），计数 +1', () => {
  const queue = new DeferredWriteQueue();
  handleWriteFailure(queue, LOCK_TIMEOUT_ERROR, 'PAYLOAD');
  const item = queue.take();
  assert.equal(queue.retry(item), true, '锁超时必须放回原槽继续重试');
  const again = queue.take();
  assert.notEqual(again, null, '放回后必须还取得到（不是终局丢弃）');
  assert.equal(again.payload, 'PAYLOAD');
  assert.equal(again.attempts, 1);
});

run('未知类的 kind 与「可重试」两类的 kind 不共用（分桶统计才立得住）', () => {
  const kinds = new Set([
    triageWriteFailure(NESTED_ERROR, 'push').kind,
    triageWriteFailure(LOCK_TIMEOUT_ERROR, 'push').kind,
    triageWriteFailure(UNKNOWN_ERROR, 'push').kind,
  ]);
  assert.equal(kinds.size, 3);
});

// ── 3. 隐私口径：留痕不带载荷正文 ─────────────────────────────────────────────────
run('分诊结论里只有类别与 kind，不含任何载荷正文', () => {
  const triage = triageWriteFailure(LOCK_TIMEOUT_ERROR, 'push');
  assert.deepEqual(
    Object.keys(triage).sort(),
    ['cls', 'deferredKind', 'disposition', 'kind', 'label', 'suffix'],
  );
  assert.ok(!JSON.stringify(triage).includes('package.json'), '留痕材料里不该出现路径之类的正文');
});

// ── 4. 接线静态守卫（src/index.ts）────────────────────────────────────────────────
const hostSource = (() => {
  const raw = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
})();

run('push 失败分支走三态分诊，并按 disposition 分流', () => {
  assert.match(hostSource, /triageWriteFailure\(error, 'push'\)/, 'push 的失败分支必须走分诊函数');
  assert.match(hostSource, /if \(triage\.disposition === 'queue'\)/, '必须按处置分流，不能只认一种失败');
});

run('push 的「排队」分支真的把载荷排进补写队列', () => {
  assert.match(hostSource, /deferred\.enqueuePush\(\{ payload, fingerprint, carriesCompletion \}/, '可重试的失败必须排进 push 槽');
});

run('push 的「丢弃」分支不得排进队列（未知类保持终局丢弃）', () => {
  const dropAt = hostSource.indexOf('push to client failed');
  assert.ok(dropAt > 0, '找不到 push 的丢弃分支');
  const branch = hostSource.slice(dropAt, dropAt + 400);
  assert.ok(!branch.includes('enqueuePush'), '未知类不进队列');
  assert.ok(!branch.includes('enqueueClearOps'), '未知类不进队列');
});

run('_ops 清空分支同样走分诊：可重试的排队，未知的丢弃', () => {
  assert.match(hostSource, /triageWriteFailure\(error, 'clearOps'\)/, '_ops 清空分支必须走分诊函数');
  const at = hostSource.indexOf("triageWriteFailure(error, 'clearOps')");
  const queueAt = hostSource.indexOf('deferred.enqueueClearOps(consumedPayload', at);
  assert.ok(queueAt > at, '可重试的清空失败必须排进 clearOps 槽');
  const dropAt = hostSource.indexOf('_ops clear failed', at);
  assert.ok(dropAt > queueAt, '丢弃分支必须在排队分支之后');
  const branch = hostSource.slice(dropAt, dropAt + 400);
  assert.ok(!branch.includes('enqueueClearOps'), '未知类不进队列');
});

run('三处留痕的 kind 都取自分诊结论（不写死，便于按 kind 分桶统计）', () => {
  const uses = hostSource.match(/traceFault\(\s*triage\.kind/g) ?? [];
  assert.ok(uses.length >= 3, `push / _ops 清空 / 泵内重试三处都该用 triage.kind，实得 ${uses.length} 处`);
  assert.match(hostSource, /traceFault\(\s*triage\.deferredKind/, '泵内重试的 kind 也要按类别分开');
});

run('排队期间不放指纹 ⇒ 同一份内容的后续推送不会重复走那条注定被拒的即时写', () => {
  const at = hostSource.indexOf("triageWriteFailure(error, 'push')");
  const queueAt = hostSource.indexOf('deferred.enqueuePush(', at);
  assert.ok(at > 0 && queueAt > at);
  const branch = hostSource.slice(at, queueAt);
  assert.ok(
    !/lastPushFingerprint = null;/.test(branch),
    '排队分支里不该直接清指纹：载荷已在槽里，只有补写最终没成才放开（releaseDeferredPushFingerprint）',
  );
});

run('泵在即时写还在途时不抢锁（抢锁就是锁超时的来源）', () => {
  assert.match(hostSource, /function drainDeferred\(\): void \{/, '找不到 drainDeferred');
  const fnAt = hostSource.indexOf('function drainDeferred(): void {');
  const guardAt = hostSource.indexOf('anyWriteInFlight()', fnAt);
  const takeAt = hostSource.indexOf('deferred.take()', fnAt);
  assert.ok(guardAt > fnAt, 'drainDeferred 必须检查在途写');
  assert.ok(takeAt > guardAt, '检查必须在取槽之前：取出来就得放回，白折腾');
});

run('即时写在补写/清空占着锁时也不抢锁（互斥的另一半方向）', () => {
  assert.match(
    hostSource,
    /if \(deferredWriteInFlight !== null \|\| opsClearInFlight !== null\) \{\s*\n\s*pushWaitingForWrite = true;/,
    '即时写必须等补写与清空落地，不与它们抢同一把 profile 锁',
  );
  assert.match(hostSource, /const anyWriteInFlight = \(\): boolean =>/, '在途写的判定必须是单一入口');
});

run('等锁时长留痕（deferred-wait + waitedMs），按 kind 分桶节流', () => {
  assert.match(hostSource, /traceFault\('deferred-wait'/, '等锁必须留痕');
  assert.match(hostSource, /waitedMs=\$\{waitedMs\}/, '留痕必须带等了多久');
  assert.ok(!/waitedMs=\$\{waitedMs\}[^`]*payload/.test(hostSource), '等锁留痕不带载荷');
});

run('三类在途写都被记账（补写 / 即时写 / _ops 清空）', () => {
  for (const name of ['deferredWriteInFlight', 'opsClearInFlight', 'pushInFlight']) {
    assert.ok(hostSource.includes(`let ${name}: Promise<void> | null = null;`), `缺少 ${name} 的在途记账`);
  }
});

console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} push-failure-triage-smoke: ${cases} 组用例${process.exitCode === 1 ? '（有失败）' : '全部通过'}`);
