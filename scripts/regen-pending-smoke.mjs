/**
 * 「换一条」的**在途呈现**判据（Gitea #127 / #139 共用口径）。
 *
 * ## 这条要钉的是「派生」而不是「一次性写」
 *
 * `_push` 是**省略式拼装**：某个键不出现时，下一次任何推送都会把它抹掉。`error` 键
 * 就是这么丢的（#136 实测：live 里 `_push` 没有 `error` 不等于从没写过）。所以
 * `regenPending` 必须**每次组装载荷时现算**（`regenPendingFor(sessionId)`），
 * 而不是「在途开始时写进去、等它自己消失」。
 *
 * 本冒烟读**源码形状**而不是跑真宿主：这条判据是「载荷从哪个函数派生」的结构问题，
 * 真宿主里跑一百次也区分不出「现算」与「写了一次还没被抹掉」——那正是需要形状断言的地方
 * （`docs/gitea-workflow.md` §5：形状可以严格蕴含语义，且改名绕不过位置约束）。
 *
 * 用法：node scripts/regen-pending-smoke.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const host = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
const settings = readFileSync(fileURLToPath(new URL('../src/settings.ts', import.meta.url)), 'utf8');
const client = readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8');

let passed = 0;
const run = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`      ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

/** 取某个函数体（从签名到下一个顶格 `};` 或 `}`），用于「在这段里找某串」。 */
const bodyOf = (source, signature, endMarker = '\n  };') => {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `源码里找不到签名：${signature}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end > start, `签名之后找不到结束标记 ${JSON.stringify(endMarker)}`);
  return source.slice(start, end);
};

console.log('\n—— 载荷派生（现算，不是一次性写）——');

run('statePushOf 里 regenPending 由 regenPendingFor(...) 现算', () => {
  const body = bodyOf(host, 'const statePushOf = (');
  assert.match(
    body,
    /regenPendingFor\(sessionId\)/,
    'statePushOf 没有调 regenPendingFor：那意味着 pending 是别处一次性写进去的（会被下一次无关推送抹掉）',
  );
});

run('regenPendingFor 读的是宿主在途集合，不是某个可被抹掉的变量', () => {
  const start = host.indexOf('const regenPendingFor = (');
  assert.ok(start >= 0, '找不到 regenPendingFor');
  const snippet = host.slice(start, start + 400);
  assert.match(snippet, /regenInFlight\.has\(/, 'regenPendingFor 没读在途集合');
});

run('序列化出口只在 true 时写键（不在途 ⇒ 零额外字节）', () => {
  const body = bodyOf(host, 'const buildPushPayload = (');
  assert.match(body, /regenPending === true \? \{ regenPending: true \}/, '序列化不是「只在 true 时写」的形状');
  assert.ok(!/regenPending:\s*false/.test(body), '序列化里出现了显式 false：那会让每次推送都携带这个键（指纹每格都变）');
});

console.log('\n—— 客户端读取 ——');

run('客户端读 `pushed?.regenPending === true`（缺省即不在途，旧宿主无害）', () => {
  assert.match(client, /regenPending: pushed\?\.regenPending === true/);
});

run('在途位进 content key（否则边沿不触发重绘）', () => {
  assert.match(client, /llm:\$\{result\.pending \? 'pending:' : ''\}/);
});

run('在途位标在自己节点上（纯读 DOM 可取证）', () => {
  assert.match(client, /this\.el\.dataset\.regenPending = '1'/);
  assert.match(client, /delete this\.el\.dataset\.regenPending/);
});

console.log('\n—— 形状声明 ——');

run('载荷形状里 regenPending 是可选布尔（旧载荷兼容）', () => {
  assert.match(settings, /readonly regenPending\?: boolean/);
  assert.match(client, /regenPending\?: unknown/);
});

console.log(`\n${process.exitCode === 1 ? '❌' : '✅'} regen-pending: ${passed} 组断言${process.exitCode === 1 ? '有失败' : '全部通过'}`);
