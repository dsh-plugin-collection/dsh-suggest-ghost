#!/usr/bin/env node
/**
 * `_ops` 写队列 + 冲突退避的离线冒烟。
 *
 * 覆盖 `src/client/ops-write-queue.ts`（串行 / FIFO / complete 排队中 last-wins /
 * pull 不合并 / run 抛错后队列继续）与 `src/client/settings-result.ts` 新增的重试
 * 预算与退避纯函数。
 *
 * **不依赖真实等待**：队列本身没有定时器，测试用手动 resolve 的假 run 驱动；退避
 * 只断言 `opsConflictBackoffMs` 的纯函数序列（真 `setTimeout` 在 `index.ts` 的调用点，
 * 这里睡 375ms 不会让结论更强，只会让冒烟变慢）。微任务轮转代替假时钟。
 *
 * 运行：`node --experimental-strip-types scripts/ops-write-queue-smoke.mjs`
 * （两个源模块都没有 `.js` 裸说明符依赖，Node 的类型剥离可直接加载）。
 */
import assert from 'node:assert/strict';
import { OpsWriteQueue } from '../src/client/ops-write-queue.ts';
import {
  OPS_WRITE_CONFLICT_BACKOFF_CAP_MS,
  OPS_WRITE_MAX_ATTEMPTS,
  opsConflictBackoffMs,
  opsConflictRetryAllowed,
} from '../src/client/settings-result.ts';

let failed = 0;
const run = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

/** 让排队的微任务跑完（替代假时钟：队列/回退都是微任务，不需要真实时间）。 */
const flush = async () => {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
};

/**
 * 手动 resolve 的假 run：记录启动顺序、并发峰值，并把每项的 resolver 暴露给测试
 * 逐个放行——这样「同一时刻至多一个在途」可以被真正观察到，而不是靠耗时推断。
 */
function controlledRun() {
  const started = [];
  const gates = [];
  let active = 0;
  let maxActive = 0;
  return {
    started,
    gates,
    maxActive: () => maxActive,
    run: (payload) => {
      started.push(payload);
      active += 1;
      if (active > maxActive) maxActive = active;
      return new Promise((resolve) => {
        gates.push((landed) => {
          active -= 1;
          resolve(landed);
        });
      });
    },
  };
}

// —— 1. 串行 + FIFO（同一时刻至多一个 run 在途）——
await run('串行：maxConcurrency=1，按 FIFO 执行，size 只数排队项', async () => {
  const harness = controlledRun();
  const queue = new OpsWriteQueue(harness.run);
  const promises = ['p1', 'p2', 'p3'].map((payload) => queue.enqueue(payload, 'pull'));
  await flush();
  assert.deepEqual(harness.started, ['p1'], '只允许一个 run 在途');
  assert.equal(queue.size, 2, '在途项不计入 size');
  harness.gates[0](true);
  await flush();
  assert.deepEqual(harness.started, ['p1', 'p2']);
  harness.gates[1](true);
  await flush();
  assert.deepEqual(harness.started, ['p1', 'p2', 'p3']);
  harness.gates[2](true);
  await flush();
  assert.equal(harness.maxActive(), 1, '并发峰值必须是 1');
  assert.deepEqual(await Promise.all(promises), [true, true, true]);
  assert.equal(queue.size, 0);
});

// —— 2. complete 在排队中 last-wins：被取代者 resolve(false) 且绝不发送 ——
await run('complete 排队中 last-wins：被取代者兑现 false（未发送）', async () => {
  const harness = controlledRun();
  const queue = new OpsWriteQueue(harness.run);
  const blocker = queue.enqueue('blocker', 'pull'); // 占住唯一的在途位
  const stale = queue.enqueue('complete-old', 'complete');
  const fresh = queue.enqueue('complete-new', 'complete');
  assert.equal(await stale, false, '被取代的 complete 必须兑现 false，语义是「未发送」');
  await flush();
  assert.deepEqual(harness.started, ['blocker']);
  harness.gates[0](true);
  await flush();
  assert.deepEqual(harness.started, ['blocker', 'complete-new'], '旧 complete 不得被执行');
  harness.gates[1](true);
  await flush();
  assert.equal(await fresh, true);
  assert.equal(await blocker, true);
});

// —— 3. 在途的 complete 不被取消（只有排队中的才合并）——
await run('在途 complete 不可取代：新 complete 排在它后面', async () => {
  const harness = controlledRun();
  const queue = new OpsWriteQueue(harness.run);
  const first = queue.enqueue('c1', 'complete');
  await flush();
  assert.deepEqual(harness.started, ['c1']);
  const second = queue.enqueue('c2', 'complete');
  assert.equal(queue.size, 1, '在途项无法取消 ⇒ 新 complete 只能排队');
  harness.gates[0](false);
  await flush();
  assert.deepEqual(harness.started, ['c1', 'c2'], '已发出的 complete 仍会执行');
  harness.gates[1](true);
  await flush();
  assert.equal(await first, false, 'run 的兑现值原样透传（false = 没拿到落盘凭证）');
  assert.equal(await second, true);
});

// —— 4. pull 不合并：每条对账请求各自执行 ——
await run('pull 不合并：三条 pull 产生三次 run', async () => {
  const harness = controlledRun();
  const queue = new OpsWriteQueue(harness.run);
  const promises = ['pull-a', 'pull-b', 'pull-c'].map((payload) => queue.enqueue(payload, 'pull'));
  await flush();
  assert.equal(queue.size, 2, 'pull 不得被合并（排队 2 项，不是 1 项）');
  harness.gates[0](true);
  await flush();
  harness.gates[1](true);
  await flush();
  harness.gates[2](true);
  await flush();
  assert.deepEqual(harness.started, ['pull-a', 'pull-b', 'pull-c']);
  assert.deepEqual(await Promise.all(promises), [true, true, true]);
});

// —— 5. run 抛错 / reject：该项 false，队列继续 ——
await run('run 抛错：该项 resolve(false)，后续项照常执行', async () => {
  const calls = [];
  const queue = new OpsWriteQueue(async (payload) => {
    calls.push(payload);
    if (payload === 'sync-throw') throw new Error('boom');
    if (payload === 'async-reject') return Promise.reject(new Error('nope'));
    return true;
  });
  const results = await Promise.all([
    queue.enqueue('sync-throw', 'pull'),
    queue.enqueue('async-reject', 'pull'),
    queue.enqueue('ok', 'pull'),
  ]);
  assert.deepEqual(results, [false, false, true]);
  assert.deepEqual(calls, ['sync-throw', 'async-reject', 'ok'], '异常不得让队列丢项或停摆');
  assert.equal(queue.size, 0);
});

// —— 6. 退避序列：递增到封顶，且只消耗 MAX-1 档 ——
await run('冲突退避：100/200/400/800/1600… 递增后封顶', async () => {
  const backoffs = [];
  for (let attempt = 0; opsConflictRetryAllowed(attempt); attempt += 1) {
    backoffs.push(opsConflictBackoffMs(attempt));
  }
  assert.deepEqual(backoffs, [100, 200, 400, 800, 1600, 1600, 1600]);
  assert.equal(backoffs.length, OPS_WRITE_MAX_ATTEMPTS - 1, '总次数 8 ⇒ 最多 7 次重试退避');
  // 封顶前严格递增；封顶后允许持平（截断是设计，不是 bug）。
  for (let i = 1; i < backoffs.length; i += 1) {
    assert.ok(backoffs[i] >= backoffs[i - 1], `退避不得回退：${backoffs[i - 1]} → ${backoffs[i]}`);
    if (backoffs[i - 1] < OPS_WRITE_CONFLICT_BACKOFF_CAP_MS) {
      assert.ok(backoffs[i] > backoffs[i - 1], `未封顶的档位必须严格大于上一档：${backoffs[i - 1]} → ${backoffs[i]}`);
    }
  }
  for (let attempt = 0; attempt <= OPS_WRITE_MAX_ATTEMPTS + 3; attempt += 1) {
    const ms = opsConflictBackoffMs(attempt);
    assert.ok(Number.isFinite(ms), `attempt=${attempt} 不得返回 NaN/Infinity`);
    assert.ok(ms >= 100 && ms <= OPS_WRITE_CONFLICT_BACKOFF_CAP_MS, `attempt=${attempt} 退避越界：${ms}`);
  }
  assert.equal(opsConflictBackoffMs(OPS_WRITE_MAX_ATTEMPTS), OPS_WRITE_CONFLICT_BACKOFF_CAP_MS);
  assert.equal(opsConflictBackoffMs(999), OPS_WRITE_CONFLICT_BACKOFF_CAP_MS, '大 attempt 必须截断，不许指数爆炸');
  assert.equal(opsConflictBackoffMs(-3), 100, '非法 attempt 退回第一档（不返回 NaN ⇒ setTimeout 不退化 0ms）');
  assert.equal(opsConflictBackoffMs(Number.NaN), 100);
});

// —— 7. 重试边界：attempt 0..MAX-2 可重试，MAX-1 起放弃 ——
await run('重试边界：总尝试次数 OPS_WRITE_MAX_ATTEMPTS=8，边界不外溢', async () => {
  assert.equal(OPS_WRITE_MAX_ATTEMPTS, 8);
  assert.equal(opsConflictRetryAllowed(0), true);
  assert.equal(opsConflictRetryAllowed(OPS_WRITE_MAX_ATTEMPTS - 2), true);
  assert.equal(opsConflictRetryAllowed(OPS_WRITE_MAX_ATTEMPTS - 1), false, '第 8 次尝试失败后必须放弃');
  assert.equal(opsConflictRetryAllowed(OPS_WRITE_MAX_ATTEMPTS), false);
  assert.equal(opsConflictRetryAllowed(1e6), false);
  assert.equal(opsConflictRetryAllowed(-1), false);
  assert.equal(opsConflictRetryAllowed(1.5), false, '非整数 attempt 不得被当成合法档位');
  for (let attempt = 0; attempt <= OPS_WRITE_MAX_ATTEMPTS; attempt += 1) {
    assert.equal(
      opsConflictRetryAllowed(attempt),
      attempt < OPS_WRITE_MAX_ATTEMPTS - 1,
      `attempt=${attempt} 的可重试判定必须是 attempt < MAX-1`,
    );
  }
});

// —— 8. 看门狗：永不兑现的 run 不得永久占住槽位 ——
await run('看门狗：hung run 超时后该项 false、后续项照常（通道不被单条 RPC 卡死）', async () => {
  const executed = [];
  let releaseHeld;
  const held = new Promise((resolve) => { releaseHeld = resolve; });
  const q = new OpsWriteQueue(async (payload) => {
    executed.push(payload);
    if (payload === 'hang') return held.then(() => true); // 永不兑现（除非测试结尾放行）
    return true;
  }, 20); // 20ms 看门狗：真实计时器但极短（这一组是队列唯一需要真时间的断言）
  const first = q.enqueue('hang', 'pull');
  const second = q.enqueue('after-hang', 'pull');
  assert.equal(await first, false, '挂起项必须被看门狗判 false');
  assert.equal(await second, true, '看门狗放行后，后续项必须照常执行');
  assert.deepEqual(executed, ['hang', 'after-hang'], '两项都执行过（短暂并发是文档化的代价）');
  releaseHeld(); // 放行迟到 run：它的兑现必须被丢弃，不得把已了结的项改判
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await first, false, '迟到兑现不得翻转已判定的结果');
});

if (failed > 0) {
  console.error(`ops-write-queue smoke: ${failed} 组失败`);
  process.exit(1);
}
console.log('ops-write-queue smoke: 8 组断言通过（串行/FIFO、complete last-wins、在途不取消、pull 不合并、异常续跑、退避序列、重试边界、看门狗放行）');
