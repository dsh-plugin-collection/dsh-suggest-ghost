#!/usr/bin/env node
/**
 * 「别再给我补这句」（本单）的语义冒烟：忽略表本身 + 三条判定路径 + 持久往返。
 *
 * ## 为什么这道闸必须存在
 *
 * 本单修的是一条**看起来能生效、其实只生效一半**的路径。实测过的三种假成功：
 *  1. 只删热表条目 ⇒ 屏幕上的幽灵**照旧出现**（它来自会话历史环，不是热表）；
 *  2. 只过滤候选 ⇒ 界面安静了，但用户**再打一次那句话它就以 `×1` 复活**；
 *  3. 只改内存 ⇒ 宿主重启后从会话日志重新物化，删掉的句子**全部回来**。
 * 三者各自都能"演示得像修好了"，而它们对应三处不同的判定点。所以本脚本按
 * **判定点**分节断言，每节都写清它拦的是上面哪一条。
 *
 * ## 加载方式（两个来源，各自有理由）
 *
 *  - `src/forget.ts` + `src/client/history.ts`：纯逻辑，用 `--experimental-strip-types`
 *    直载 TS 源（与 `history-smoke.mjs` 同款）；
 *  - `lib/hotness-store.js` 的 `applyOps` / `parseHotnessOps`：它们是宿主编译单元
 *    （内部用 `.js` 说明符），strip-types 载不动 ⇒ 取构建产物。产物比 src 旧时**大声
 *    警告**（与 `ops-schema-coverage-smoke.mjs` 同一口径）：改完 src 记得先
 *    `node build.mjs`，否则本脚本断言的是上一次构建的字节。
 *
 * 用法：node --experimental-strip-types scripts/forget-smoke.mjs
 */
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historySuggestion, normalizeForMatch } from '../src/client/history.ts';
// 与 `hotness-store` 同一条理由取产物：`src/forget.ts` 是**宿主编译单元**（它要能被
// `src/hotness-store.ts` 正常 import，那一侧用 NodeNext 的 `.js` 说明符），因此
// **不能**像 `src/client/history.ts` 那样写成 `.ts` 来迁就 strip-types —— 那会让
// `tsc -p tsconfig.json` 报 TS5097（该配置没开 `allowImportingTsExtensions`）。
// 于是本脚本对它的断言跑在产物上；新鲜度由上面第 0 节警告兜住。
import { FORGET_MAX_ENTRIES, ForgetTable, isForgotten } from '../lib/forget.js';
import { HotnessTable } from '../src/hotness.ts';
import { parseHotnessOps } from '../lib/hotness-store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// —— 0. 构建产物新鲜度（不失败，只大声警告）——
{
  const stale = ['hotness-store', 'forget', 'hotness', 'text-match']
    .filter((name) => statSync(join(root, `src/${name}.ts`)).mtimeMs > statSync(join(root, `lib/${name}.js`)).mtimeMs);
  if (stale.length > 0) {
    process.stderr.write(`⚠️  lib/ 比 src 旧（${stale.join(', ')}），先跑 \`node build.mjs\` 再看本脚本结论\n`);
  }
}

let passed = 0;
const check = (name, fn, detail) => {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${String(error.message).split('\n')[0]}`);
    if (detail !== undefined) console.error(`      实测：${detail()}`);
    process.exitCode = 1;
  }
};

const R = '帮我看下这个日志';
const T = '帮我写个单元测试';

// ═══ 1. 忽略表本体：加 / 幂等 / 归一化 / 恢复 / 清空 ═══════════════════════
{
  const f = new ForgetTable();
  check('add 一次 → size 1，且 has 命中', () => {
    assert.equal(f.add(R), true);
    assert.equal(f.size, 1);
    assert.equal(f.has(R), true);
  });
  check('add 同一句两次 → 幂等（返回 false，size 不变）', () => {
    assert.equal(f.add(R), false);
    assert.equal(f.size, 1);
  });
  check('归一化口径：全角/大小写/空白差异都算同一句', () => {
    const g = new ForgetTable();
    g.add('ＨＥＬＬＯ，World'); // 归一化 → 'hello,world'
    assert.equal(g.size, 1);
    assert.equal(g.has('hello,world'), true, '全角逗号 + 大写应归一化后命中');
    assert.equal(g.has('  hello,world '), true, '首尾空白应折叠掉');
    assert.equal(g.has('hello world'), false, '去掉逗号是另一句，不许误伤');
    // 判据的**真实口径**（不看直觉）：逗号被保留、空格被折叠而不是删除，所以
    // 「hello world」与「hello,world」是两句 —— 这条写在这里是给下一个读的人看的。
    assert.equal(normalizeForMatch('ＨＥＬＬＯ，World'), 'hello,world');
  });
  check('remove 命中 → 真的摘掉（幂等再调返回 false）', () => {
    assert.equal(f.remove(R), true);
    assert.equal(f.size, 0);
    assert.equal(f.has(R), false);
    assert.equal(f.remove(R), false);
  });
  check('clearAll 返回清掉的条数', () => {
    const g = new ForgetTable();
    g.add('甲'); g.add('乙'); g.add('丙');
    assert.equal(g.clearAll(), 3);
    assert.equal(g.size, 0);
  });
  check('snapshot 按插入序（最早的在前，与 FIFO 淘汰同序）', () => {
    const g = new ForgetTable();
    g.add('甲'); g.add('乙');
    assert.deepEqual(g.snapshot().map(e => e.text), ['甲', '乙']);
    assert.deepEqual(g.snapshot(1).map(e => e.text), ['甲']);
  });
  check('原文刷新不重置 FIFO 序（同一句换大小写后仍在原位）', () => {
    const g = new ForgetTable();
    g.add('甲'); g.add('乙');
    assert.equal(g.add(' 乙 '), false, '归一化后同句且原文 trim 相同 ⇒ 幂等');
    g.add('丙');
    assert.deepEqual(g.snapshot().map(e => e.text), ['甲', '乙', '丙']);
  });
  check('空串 / 超长 / 纯空白一律不收', () => {
    const g = new ForgetTable();
    assert.equal(g.add(''), false);
    assert.equal(g.add('   '), false);
    assert.equal(g.add('x'.repeat(2001)), false);
    assert.equal(g.size, 0);
  });
  check('容量上限：满 FORGET_MAX_ENTRIES 后淘汰插入最早的那条', () => {
    const g = new ForgetTable();
    for (let i = 0; i < FORGET_MAX_ENTRIES; i += 1) g.add(`句-${i}`);
    assert.equal(g.size, FORGET_MAX_ENTRIES);
    assert.equal(g.has('句-0'), true);
    g.add('新来的');
    assert.equal(g.size, FORGET_MAX_ENTRIES, '插入后仍在上限内');
    assert.equal(g.has('句-0'), false, '最早插入的应被淘汰');
    assert.equal(g.has('新来的'), true);
  });
  check('变更回调：加/删/淘汰各自上报（持久层靠它标脏）', () => {
    const events = [];
    const g = new ForgetTable((entry, norm) => events.push([norm, entry === null ? null : entry.text]));
    g.add('甲');
    g.remove('甲');
    assert.deepEqual(events, [['甲', '甲'], ['甲', null]]);
  });
  check('restoreEntry 不回火 onChange（数据来自持久层，回写纯浪费）', () => {
    const events = [];
    const g = new ForgetTable((entry, norm) => events.push([norm, entry]));
    g.restoreEntry('甲');
    g.restoreEntry('甲', '甲');
    assert.equal(g.size, 1);
    assert.equal(events.length, 0);
    assert.equal(g.has('甲'), true);
  });
  check('isForgotten 对 null / 空集返回 false（热路径不制造额外分配）', () => {
    assert.equal(isForgotten(undefined, R), false);
    assert.equal(isForgotten(null, R), false);
    assert.equal(isForgotten(new Set(), R), false);
  });
}

// ═══ 2. 判定点①：候选过滤（拦「删了热表照样补」那条）════════════════════
{
  const ignored = new Set([normalizeForMatch(R)]);
  const hotCounts = new Map([[normalizeForMatch(R), 40]]);

  check('会话历史里的那句被忽略后 ⇒ 不进入候选（这是屏幕上那句的实际来源）', () => {
    assert.equal(historySuggestion(['先前的消息', R, '别的消息'], '帮我', {
      minChars: 1, maxEntries: 50, hotCounts, ignored,
    }), undefined);
  });

  check('**不加 ignored** 时同一组输入仍然返回它（反向对照：证明上面那条不是自证）', () => {
    assert.equal(historySuggestion(['先前的消息', R, '别的消息'], '帮我', {
      minChars: 1, maxEntries: 50, hotCounts,
    }), R);
  });

  check('跨会话候选（extraCandidates）同样被过滤 —— 两条来源一个入口', () => {
    assert.equal(historySuggestion(['完全无关的一句'], '帮我', {
      minChars: 1, maxEntries: 50, hotCounts,
      extraCandidates: [{ text: R, count: 40 }],
      ignored,
    }), undefined);
  });

  check('只忽略 A 时 B 仍可补出（过滤不是把候选池清空）', () => {
    assert.equal(historySuggestion([T, R], '帮我', {
      minChars: 1, maxEntries: 50, ignored,
    }), T);
  });

  check('忽略表按归一化匹配：历史里是全角写法也拦得住', () => {
    const g = new ForgetTable();
    g.add('帮我，看下日志'); // 触发归一化：全角逗号 → 半角
    assert.equal(historySuggestion(['帮我,看下日志'], '帮我', {
      minChars: 1, maxEntries: 0, ignored: g.asSet(),
    }), undefined);
  });

  check('前缀不命中时本来就不返回（过滤不改变这条既有语义）', () => {
    assert.equal(historySuggestion([T], '帮我看', { minChars: 1, maxEntries: 0, ignored }), undefined);
  });
}

// ═══ 3. 判定点②：热度记账闸（拦「再打一次就复活」那条）═══════════════════
{
  const ev = (text, seq) => ({
    type: 'user/message',
    seq,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  });

  check('被忽略的文本不再进热表（全新安装路径）', () => {
    const g = new ForgetTable();
    g.add(R);
    const hot = new HotnessTable(undefined, (text) => g.has(text));
    hot.consume(ev(R, 1), 's1');
    hot.consume(ev(R, 2), 's2');
    assert.equal(hot.size, 0, '被忽略的句子一次都不该记账');
  });

  check('★ 删掉之后**再打一次**也不复活（同会话、隔一句、跨会话三种形态）', () => {
    const g = new ForgetTable();
    const hot = new HotnessTable(undefined, (text) => g.has(text));
    hot.consume(ev(R, 1), 's1');
    hot.consume(ev(R, 2), 's1');
    assert.equal(hot.snapshot(10)[0]?.count, 1, '前置：先正常记了 1 次（相邻去重生效）');
    // 用户按了「别再补这句」：进忽略表 + 删热表那条（与 applyOps 的 forget 分支同序）
    g.add(R);
    hot.deleteEntry(R);
    assert.equal(hot.size, 0);
    // 三种「再来一次」的真实路径
    hot.consume(ev('中间说了别的', 3), 's1');
    hot.consume(ev(R, 4), 's1'); // ① 同会话，隔一句
    hot.consume(ev(R, 5), 's2'); // ② 换个会话
    assert.equal(hot.size, 1, '只剩「中间说了别的」那一句');
    assert.equal(hot.snapshot(10).some(e => e.text === R), false, '被忽略的句子不许以 ×1 复活');
  });

  check('**不给谓词**时同一路径确实会复活（反向对照，证明上面那条不是自证）', () => {
    const hot = new HotnessTable();
    hot.consume(ev(R, 1), 's1');
    hot.deleteEntry(R);
    assert.equal(hot.size, 0, '前置：删掉了');
    // 隔一句再打（同会话相邻重复在闸之前就 return，那是既有语义，不是"复活"）
    hot.consume(ev('中间说了别的', 2), 's1');
    hot.consume(ev(R, 3), 's1');
    assert.equal(hot.snapshot(10).some(e => e.text === R), true, '没有记账闸时它会回来 —— 这正是本单要堵的洞');
  });

  check('相邻去重语义不变：被忽略的句子仍推进「本会话最后一句」', () => {
    const g = new ForgetTable();
    g.add(R);
    const hot = new HotnessTable(undefined, (text) => g.has(text));
    hot.consume(ev(R, 1), 's1');
    hot.consume(ev('下一句', 2), 's1');
    assert.deepEqual(hot.snapshot(10).map(e => e.text), ['下一句']);
  });

  check('恢复之后重新可以记账（restore 把洞打开）', () => {
    const g = new ForgetTable();
    g.add(R);
    const hot = new HotnessTable(undefined, (text) => g.has(text));
    hot.consume(ev(R, 1), 's1');
    assert.equal(hot.size, 0);
    g.remove(R);
    // ⚠️ 换会话而不是同会话：同会话相邻重复在**闸之前**就 return 了（那是既有语义，
    // 与本单无关）。第一版这里写的是 `'s1'`，断言红了但红得对 —— 它证明的是
    // 「相邻去重仍然优先于记账闸」，不是「restore 没生效」。
    hot.consume(ev(R, 2), 's2');
    assert.equal(hot.size, 1, '恢复后应重新记账');
  });
}

// ═══ 4. `_ops` schema：forget / restore 能被解析（拦「整批静默丢弃」那条）═══
{
  check('forget / restore 都在 schema 的白名单里', () => {
    const parsed = parseHotnessOps(JSON.stringify({
      rev: 1,
      ops: [{ op: 'forget', text: R }, { op: 'restore', text: R }],
    }));
    assert.equal(parsed.rejected, undefined, `被 schema 拒绝：${parsed.rejected?.summary ?? ''}`);
    assert.equal(parsed.ops.length, 2);
    assert.equal(parsed.ops[0].op, 'forget');
    assert.equal(parsed.ops[1].op, 'restore');
  });

  check('forget 的 text 为空 / 超长 ⇒ 整批拒绝并留痕（不是静默通过）', () => {
    for (const bad of ['', 'x'.repeat(2001)]) {
      const parsed = parseHotnessOps(JSON.stringify({ rev: 1, ops: [{ op: 'forget', text: bad }] }));
      assert.equal(parsed.ops.length, 0, `text=${bad.slice(0, 4)}… 不该被放行`);
      assert.ok(parsed.rejected !== undefined, '拒绝必须留痕');
    }
  });
}

// ═══ 5. 端到端：filter + 记账闸 + 热表删除三处同时生效才算「修好了」 ═══════
{
  const g = new ForgetTable();
  const hot = new HotnessTable(undefined, (text) => g.has(text));
  const ev = (text, seq) => ({
    type: 'user/message',
    seq,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  });
  hot.consume(ev(R, 1), 's1');
  const ring = ['先前的消息', R, '中间说了别的'];
  const hotCounts = () => new Map(hot.snapshot(50).map(e => [normalizeForMatch(e.text), e.count]));

  check('起点：会补出 R（前置条件成立才谈得上"拦住"）', () => {
    assert.equal(historySuggestion(ring, '帮我', { minChars: 1, maxEntries: 50, hotCounts: hotCounts() }), R);
  });

  // 用户按下「别再补这句」：applyOps 的 forget 分支做的正是这两笔
  g.add(R);
  hot.deleteEntry(R);

  check('① 屏幕上不再出现', () => {
    assert.equal(historySuggestion(ring, '帮我', {
      minChars: 1, maxEntries: 50, hotCounts: hotCounts(), ignored: g.asSet(),
    }), undefined);
  });

  check('② 再打一次也不复活（记账闸）', () => {
    hot.consume(ev(R, 9), 's1');
    assert.equal(hot.snapshot(10).some(e => e.text === R), false);
  });

  check('③ 设置页的热门短语列表里也没有它了（delete 那一笔的作用）', () => {
    assert.equal(hot.snapshot(50).some(e => e.text === R), false);
  });
}

// `process.exitCode` 在没设过时是 `undefined`，所以不能拿它直接比 0 ——
// 第一版就是这么写的，全绿时打印 ❌（退出码却是 0），把人往「断言没生效」上带。
console.log(`\n${(process.exitCode ?? 0) === 0 ? '✅' : '❌'} forget-smoke: ${passed} 项通过`);
