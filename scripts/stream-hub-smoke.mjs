#!/usr/bin/env node
/**
 * 流式投递宿主侧通道的冒烟测试（#108 / task-39）。
 *
 * 它钉的是**四条硬约束里能被离线证明的那几条**：
 *  1. 增量帧**不落盘** —— 用源码断言把"这个模块不认识 settings"钉死（比行为断言更硬：
 *     哪天有人顺手加一行 `settings.update`，这里先红）。
 *  2. 帧号单调 + 终帧唯一。
 *  3. **限频常量被钉住**（#62 的口径：断言常量本身，而不是只测行为）—— 宿主没有合帧
 *     原语，窗口是插件自己给的，所以它必须是一个可被 grep 到的数。
 *  4. 缓冲溢出丢的是**最旧的非终帧**，终帧永不丢（"中途内容允许被终帧丢弃"的反面）。
 *
 * 另外两条（开关关=现状一字不变、终帧仍写一次 `_push`）是行为面，由 e2e 与
 * `completion-pipeline-smoke` 的既有基线覆盖，这里不重复。
 *
 * 用法：node scripts/stream-hub-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GhostStreamHub,
  STREAM_FRAME_MIN_INTERVAL_MS,
  STREAM_BUFFER_MAX_FRAMES,
  STREAM_SUBSCRIPTION_TTL_MS,
} from '../lib/stream.js';

let cases = 0;
const run = (name, fn) => {
  cases += 1;
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
};
const runAsync = async (name, fn) => {
  cases += 1;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
};
const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 把一条订阅读到结束（或超时），返回收到的帧。 */
const collect = async (iterable, { stopAfter = 0, timeoutMs = 500 } = {}) => {
  const got = [];
  const started = Date.now();
  for await (const frame of iterable) {
    got.push(frame);
    if (frame.final) break;
    if (stopAfter > 0 && got.length >= stopAfter) break;
    if (Date.now() - started > timeoutMs) break;
  }
  return got;
};

// ── 1. 常量本身（限频窗口与缓冲上限必须是一个可 grep 的数）────────────────────
run('限频窗口是常量 60ms（宿主没有合帧原语，这个数就是插件的限频承诺）', () => {
  assert.equal(STREAM_FRAME_MIN_INTERVAL_MS, 60);
});
run('缓冲上限与 TTL 都是正数常量（改它们要同时改这里的断言）', () => {
  assert.equal(STREAM_BUFFER_MAX_FRAMES, 24);
  assert.ok(STREAM_SUBSCRIPTION_TTL_MS > STREAM_FRAME_MIN_INTERVAL_MS);
});

run('增量帧零落盘：stream.ts 不认识 settings / configEditor / 写面', () => {
  const raw = readFileSync(fileURLToPath(new URL('../src/stream.ts', import.meta.url)), 'utf8');
  // 只查**代码**，不查注释：这个模块的头注释里就写着"不碰 configEditor.edit"，
  // 拿原文去 grep 会被自己的说明文字判红（第一版就是这么红的）。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释 / JSDoc
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))  // 行注释
    .join('\n');
  for (const forbidden of ['settingsSvc', 'configEditor', 'live-settings', 'update(', 'mutate(', 'requireSettings']) {
    assert.ok(!code.includes(forbidden), `stream.ts 的代码里出现了 ${forbidden} —— 增量帧一旦碰写面就违反 #36 的验收硬判据`);
  }
  // 反向确认它确实只依赖语言运行时（真加了依赖，上面那条会先红；这条防"整文件被掏空"）
  assert.ok(/class GhostStreamHub/.test(code), 'GhostStreamHub 本体必须在');
  assert.ok(!/^\s*import\s.*from/m.test(code) || !/settings/.test(code.match(/^\s*import[^\n]*$/gm).join('\n')),
    'stream.ts 不应 import 任何 settings 相关模块');
});

// ── 2. 行为面 ──────────────────────────────────────────────────────────────
await runAsync('没人监听时 beginTurn 返回 false（= 调用方不挂 delta 回调，现状路径一字不变）', async () => {
  const hub = new GhostStreamHub();
  assert.equal(hub.beginTurn('session-a', 1), false);
  assert.equal(hub.publish('session-a', 'x'), false);
  assert.equal(hub.publishFinal('session-a', 'x'), 0);
});

await runAsync('帧号在单次生成内单调，终帧是最后一帧且唯一', async () => {
  const hub = new GhostStreamHub();
  const ac = new AbortController();
  const iterable = hub.subscribe('session-a', ac.signal);
  assert.equal(hub.beginTurn('session-a', 7), true);
  // 逐帧之间跨过限频窗口，否则会被自己限掉（那正是下一条要测的行为）。
  hub.publish('session-a', 'a');
  await sleep(STREAM_FRAME_MIN_INTERVAL_MS + 5);
  hub.publish('session-a', 'ab');
  await sleep(STREAM_FRAME_MIN_INTERVAL_MS + 5);
  hub.publishFinal('session-a', 'abc');
  const got = await collect(iterable);
  assert.deepEqual(got.map((f) => f.frame), [1, 2, 3], `帧号应单调连续：${JSON.stringify(got.map((f) => f.frame))}`);
  assert.deepEqual(got.map((f) => f.final), [false, false, true]);
  assert.equal(new Set(got.filter((f) => f.final).map((f) => f.frame)).size, 1, '终帧必须唯一');
  assert.ok(got.every((f) => f.turn === 7), '回合号随帧带出（客户端做归属校验）');
  assert.equal(got.at(-1).text, 'abc');
});

await runAsync('限频真的生效：窗口内的第二帧被吃掉（不排队、不补发）', async () => {
  const hub = new GhostStreamHub();
  const ac = new AbortController();
  const iterable = hub.subscribe('session-b', ac.signal);
  hub.beginTurn('session-b', 1);
  assert.equal(hub.publish('session-b', 'a'), true);
  assert.equal(hub.publish('session-b', 'ab'), false, '同一窗口内的第二帧必须被限掉');
  hub.publishFinal('session-b', 'abc');
  const got = await collect(iterable);
  assert.deepEqual(got.map((f) => f.text), ['a', 'abc'], `应只有首帧与终帧：${JSON.stringify(got.map((f) => f.text))}`);
});

await runAsync('缓冲溢出丢最旧的**非终帧**，终帧永不丢', async () => {
  const hub = new GhostStreamHub();
  const ac = new AbortController();
  const iterable = hub.subscribe('session-c', ac.signal);
  hub.beginTurn('session-c', 1);
  // 故意不读队列，把它灌满：每帧之间跨过限频窗口（限频本身由上一条单独测，
  // 这里测的是队列策略），所以灌 STREAM_BUFFER_MAX_FRAMES + 6 帧要 ~1.8s。
  const total = STREAM_BUFFER_MAX_FRAMES + 6;
  for (let i = 0; i < total; i += 1) {
    hub.publish('session-c', `t${i}`);
    await sleep(STREAM_FRAME_MIN_INTERVAL_MS + 2);
  }
  hub.publishFinal('session-c', 'final');
  const got = await collect(iterable);
  const finals = got.filter((f) => f.final);
  assert.equal(finals.length, 1, '终帧必须还在且只有一帧');
  assert.equal(finals[0].text, 'final');
  assert.ok(got.length <= STREAM_BUFFER_MAX_FRAMES + 2, `队列不该无界增长：${got.length}`);
  assert.notEqual(got[0].text, 't0', '最旧的非终帧应已被丢弃（丢的是中间态，不是终态）');
  assert.ok(hub.droppedFrames >= total - STREAM_BUFFER_MAX_FRAMES, `应记到丢弃计数：${hub.droppedFrames}`);
});

await runAsync('cancelTurn 不发终帧（空建议时让 _push 去清幽灵，不凭空造"可采纳的空帧"）', async () => {
  const hub = new GhostStreamHub();
  const ac = new AbortController();
  const iterable = hub.subscribe('session-d', ac.signal);
  hub.beginTurn('session-d', 1);
  hub.publish('session-d', 'partial');
  assert.equal(hub.cancelTurn('session-d'), 1);
  const got = await collect(iterable);
  assert.equal(got.some((f) => f.final), false, '取消路径不该出现终帧');
});

await runAsync('signal abort（客户端 dispose / 断线）即刻回收订阅，不留僵尸 sink', async () => {
  const hub = new GhostStreamHub();
  const ac = new AbortController();
  hub.subscribe('session-e', ac.signal);
  assert.equal(hub.channelCount, 1);
  ac.abort(new Error('Remote stream cancelled'));
  assert.equal(hub.channelCount, 0, '撤帧必须是同步回收的，否则 TTL 之前会一直挂着');
});

await runAsync('多标签页：同一会话两条订阅各自收帧，关掉一条不影响另一条', async () => {
  const hub = new GhostStreamHub();
  const a = new AbortController();
  const b = new AbortController();
  const itA = hub.subscribe('session-f', a.signal);
  const itB = hub.subscribe('session-f', b.signal);
  hub.beginTurn('session-f', 3);
  hub.publish('session-f', 'x');
  hub.publishFinal('session-f', 'xy');
  const [gotA, gotB] = await Promise.all([collect(itA), collect(itB)]);
  assert.equal(gotA.length, 2);
  assert.equal(gotB.length, 2);
  a.abort();
  assert.equal(hub.channelCount, 0, '两条都已摘掉');
});

await runAsync('closeAll 之后所有迭代结束（插件卸载不吊死客户端）', async () => {
  const hub = new GhostStreamHub();
  const ac = new AbortController();
  const iterable = hub.subscribe('session-g', ac.signal);
  hub.beginTurn('session-g', 1);
  hub.closeAll();
  const got = await collect(iterable, { timeoutMs: 200 });
  assert.equal(got.length, 0);
  assert.equal(hub.channelCount, 0);
});

await runAsync('晚到的订阅能拿到当前前缀（客户端开流必然晚于宿主 beginTurn —— 这是那条竞态的回归）', async () => {
  const hub = new GhostStreamHub();
  hub.beginTurn('session-h', 9);            // 宿主先开始生成（此刻没人听着）
  hub.publish('session-h', 'abc');           // 第一帧已经产生
  const ac = new AbortController();
  const iterable = hub.subscribe('session-h', ac.signal);   // 客户端晚到
  hub.publishFinal('session-h', 'abcd');
  const got = await collect(iterable);
  assert.ok(got.length >= 1, '晚到者至少应拿到补发的当前前缀');
  assert.equal(got[0].text, 'abc', `首帧应是补发的当前前缀，实际 ${got[0].text}`);
  assert.equal(got.at(-1).text, 'abcd', '终帧仍要收到');
  assert.equal(got.at(-1).final, true);
});

await runAsync('hasSubscribers 在没有订阅时为 false（生成侧据此一个字节都不多做）', async () => {
  const hub = new GhostStreamHub();
  assert.equal(hub.hasSubscribers('session-i'), false);
  const ac = new AbortController();
  hub.subscribe('session-i', ac.signal);
  assert.equal(hub.hasSubscribers('session-i'), true);
  ac.abort();
  assert.equal(hub.hasSubscribers('session-i'), false);
});

console.log(`\n结果：${cases} 通过, ${failures.length} 失败`);
if (failures.length > 0) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exit(1);
}
