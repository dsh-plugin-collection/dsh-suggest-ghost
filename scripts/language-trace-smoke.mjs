#!/usr/bin/env node
/**
 * 语言判定留痕冒烟（Gitea #137）。
 *
 * ## 这条闸要分开的是什么
 *
 * `uiLocale` 在宿主侧有三种彼此独立的失效方式，而**在补留痕之前它们在日志里完全同形**：
 *
 * | 形态 | 机制 | 应有的读数 |
 * |---|---|---|
 * | ① 从未捎带 | 客户端拿不到 `locale` 服务 ⇒ `buildOpsPayload` 连键都不写（`src/client/ops-envelope.ts`） | `uiLocale=absent uiLocaleAgeMs=absent` |
 * | ② 上次值残留 | `clientUiLocale` 是 apply 闭包内的**进程级单值**，last-wins，跨会话/跨客户端共享 | `uiLocale=zh uiLocaleAgeMs=931542` |
 * | ③ 本次带到 | 同一批 `_ops` 写入确实捎来了 locale | `uiLocale=zh uiLocaleAgeMs=0` |
 *
 * ①与「本次未到」在宿主侧不可分是**设计事实**（载荷没带键时，宿主无从区分"客户端拿不到
 * 服务"与"时序上还没写"）——要分它得让客户端自报"locale 服务在不在"，那在 `src/client/**`，
 * 不在 #137 范围。本冒烟因此**不断**那两者相等，只断「absent 不许读成某个语言值」。
 *
 * ## 为什么第四节是形状断言而不是语义断言
 *
 * 「留痕报的必须是本轮判定**实际用掉**的那一份值」这个语义，没法在纯函数层跑出来
 * （它取决于异步收口时读的是快照变量还是进程级变量）。而形状**严格蕴含**它：产出行里
 * 出现 `uiLocale: genUiLocale`（生成开始时取的快照）就必然报当时值；出现
 * `uiLocale: clientUiLocale`（现值）就必然可能报成下一次写入推进后的值。改名绕过不了位置约束。
 * 依据见 `docs/gitea-workflow.md` §5「形状断言 vs 语义断言」。
 *
 * 运行：`node --experimental-strip-types scripts/language-trace-smoke.mjs`
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { languageTraceKeys, traceToken } from '../src/trace.ts';

const hostSource = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));

let failed = 0;
const run = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

// ─── 1. 三态可分（纯函数层，注入即判据）────────────────────────────────────
const absent = languageTraceKeys({ language: 'English', uiLocale: undefined, uiLocaleAgeMs: undefined });
const stale = languageTraceKeys({ language: '简体中文', uiLocale: 'zh', uiLocaleAgeMs: 931542 });
const fresh = languageTraceKeys({ language: '简体中文', uiLocale: 'zh', uiLocaleAgeMs: 0 });

run('①从未捎带 ⇒ uiLocale=absent，且绝不能读成某个语言值', () => {
  assert.match(absent, /uiLocale=absent/);
  assert.match(absent, /uiLocaleAgeMs=absent/);
  // 反向断言：这是本条工单的**准入判据**——旧实现这里根本会打印不出 zh/en 之分。
  assert.doesNotMatch(absent, /uiLocale=(zh|ru|en)/);
});

run('②残留 与 ③本次带到 ⇒ 靠 age 分开（只有值分不开）', () => {
  assert.match(stale, /uiLocale=zh uiLocaleAgeMs=931542/);
  assert.match(fresh, /uiLocale=zh uiLocaleAgeMs=0/);
  assert.notEqual(stale, fresh, '残留与本次带到在留痕里同形 ⇒ 这条闸没起到作用');
  assert.notEqual(absent, stale, '从未捎带与残留同形');
});

run('结论 language= 与入参 uiLocale= 互不遮蔽（同值也不合并）', () => {
  const a = languageTraceKeys({ language: '简体中文', uiLocale: 'zh', uiLocaleAgeMs: 1 });
  const b = languageTraceKeys({ language: 'English', uiLocale: 'zh', uiLocaleAgeMs: 1 });
  assert.notEqual(a, b, '结论变了但留痕没变 ⇒ language= 被入参吞掉了');
  assert.match(b, /language=English uiLocale=zh/);
});

run('age 非有限值/负数 ⇒ absent，不许伪装成 0（0 的语义是"刚带到"）', () => {
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const out = languageTraceKeys({ language: 'English', uiLocale: 'en', uiLocaleAgeMs: bad });
    assert.match(out, /uiLocaleAgeMs=absent/, `age=${String(bad)} 应读成 absent，实际: ${out}`);
    assert.doesNotMatch(out, /uiLocaleAgeMs=0\b/, `age=${String(bad)} 不许读成 0`);
  }
});

// ─── 2. 打印面安全：值里带空白/控制字符不得拆行 ────────────────────────────
run('被打印的值含换行/空格 ⇒ 折成单 token（一行日志断成两行会打死所有 grep）', () => {
  const out = languageTraceKeys({ language: '简 体\nINJECT', uiLocale: 'zh-CN', uiLocaleAgeMs: 12.4 });
  assert.doesNotMatch(out, /[\r\n]/);
  assert.match(out, /^ [a-zA-Z]+=[^ ]+ [a-zA-Z]+=[^ ]+ [a-zA-Z]+=[^ ]+$/);
  assert.equal(traceToken('a'.repeat(80), 'x'), 'a'.repeat(24), '超长值必须截断');
});

run('空串/纯空白 = absent（不许出现 uiLocale= 空值那种半截键）', () => {
  for (const empty of ['', '   ', '\n\t']) {
    assert.match(languageTraceKeys({ language: 'English', uiLocale: empty, uiLocaleAgeMs: 5 }), /uiLocale=absent/);
  }
});

// ─── 3. 既有键序与前缀逐字未动（沙箱与别的脚本靠这些串抓行）──────────────
run('两条产出行的既有前缀与既有键序逐字仍在，新键只在行尾追加', () => {
  const completionLine = 'completion generated session=${sessionId} draftChars=${draftChars} chars=${value.text.length} in ${elapsedMs}ms ${stream} at=${Date.now()}';
  const droppedC = 'completion dropped (empty or filtered) session=${sessionId} draftChars=${draftChars} in ${elapsedMs}ms ${stream} at=${Date.now()}';
  const droppedS = 'suggestion dropped (empty or filtered) session=${session.id} turn=${turn} in ${Date.now() - genStartedAt}ms ${stream}${streamGate()} at=${Date.now()}';
  assert.ok(hostSource.includes(droppedC), '`completion dropped` 的既有段被改写了');
  assert.ok(hostSource.includes(droppedS), '`suggestion dropped` 的既有段被改写了');
  const suggestionLine = 'suggestion generated session=${session.id} turn=${turn} chars=${result.suggestion.text.length} frame=${String(result.suggestion.frame ?? 1)} in ${Date.now() - genStartedAt}ms ${stream}${streamGate()} at=${Date.now()}';
  assert.ok(hostSource.includes(completionLine), '`completion generated` 的既有段被改写了（键序/前缀动过）');
  assert.ok(hostSource.includes(suggestionLine), '`suggestion generated` 的既有段被改写了（键序/前缀动过）');
  // 新键必须紧跟在既有段之后（行尾追加），插在任何既有键之前都算破坏列位。
  for (const seg of [completionLine, suggestionLine, droppedC, droppedS]) {
    const idx = hostSource.indexOf(seg);
    assert.ok(hostSource.slice(idx + seg.length, idx + seg.length + 30).startsWith('`')
      || hostSource.slice(idx + seg.length, idx + seg.length + 40).includes('languageTraceKeys('),
      `新键没追加在行尾：…${hostSource.slice(idx + seg.length, idx + seg.length + 40)}`);
  }
});

run('sandbox.greps 全部仍能在源码里命中（改完不许让沙箱抓空）', () => {
  // 作用域必须是**整个 src/**：`completion failed|timeout|preempted|aborted` 这几条
  // 早在 #39 那轮就迁到了 `src/completion-gate.ts`，把它们算到 index.ts 头上会得到
  // 假的「串丢了」结论（本冒烟第一版就是这么红的）。
  // 例外：`apply called; artifact mtime=` 是宿主 devkit 打的行，不在本仓源码里。
  const files = ['index.ts', 'completion-gate.ts', 'generate.ts', 'sanitize.ts', 'stream.ts', 'hotness.ts',
    // #127 之后 `sandbox.greps` 里还有 `regen-*` 与 `ops consumed: regen`：它们的家是
    // `src/regen.ts`（留痕构造函数）与 `src/index.ts`（分发点）。逐文件枚举的白名单天然
    // 会漏新模块 —— 这正是本断言该抓的东西（它在合并 #127 时确实红了一次）。
    'regen.ts', 'text-match.ts', 'trace.ts',
    'client/index.ts', 'client/history.ts'].map((f) => {
    try { return readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), 'utf8'); } catch { return ''; }
  }).join('\n');
  const external = new Set(['apply called; artifact mtime=']);
  const missing = (pkg.sandbox?.greps ?? []).filter((n) => !external.has(n) && !files.includes(n));
  assert.deepEqual(missing, [], `这些 sandbox.greps 串在 src/ 里找不到了：${missing.join(' | ')}`);
  assert.ok(missing.length === 0);
});

// ─── 4. 形状蕴含语义：报的是快照，不是收口时的现值 ─────────────────────────
run('四条产出行（generated/dropped × 续写/建议）都带键，且读的是快照不是现值', () => {
  const traced = [...hostSource.matchAll(/languageTraceKeys\(\{[^}]*\}\)/g)].map((m) => m[0]);
  // 4 而不是 2：注入实测发现「生成了但被净化链丢弃」那一支（`completion dropped`）
  // 同样需要这两个键 —— 落在这条支上的那一发，语言判定的入参否则**又一次静默**。
  assert.equal(traced.length, 4, `期望四条产出行各调一次留痕函数，实际 ${traced.length} 次`);
  for (const call of traced) {
    assert.match(call, /uiLocale:\s*genUiLocale\b/, `留痕读的不是快照：${call}`);
    assert.doesNotMatch(call, /uiLocale:\s*clientUiLocale/, `留痕直接读了进程级现值 ⇒ 异步收口会报成下一次的量：${call}`);
    assert.match(call, /uiLocaleAgeMs:\s*genUiLocaleAgeMs/);
    assert.match(call, /language:\s*(value|result)\.language/);
  }
});

run('locale 的值与到达时刻成对写入（漏一个 ⇒ age 永远读成 absent）', () => {
  assert.match(
    hostSource,
    /if \(parsed\.locale !== undefined\) \{ clientUiLocale = parsed\.locale; clientUiLocaleAtMs = Date\.now\(\); \}/,
    '写入点没有同时盖到达时刻，或把两句拆开了',
  );
});

run('两条产出行仍是 traceOps（debug 心跳级），没被升级成 traceFault', () => {
  for (const prefix of ['completion generated session=', 'suggestion generated session=', 'completion dropped (empty or filtered) session=', 'suggestion dropped (empty or filtered) session=']) {
    const i = hostSource.indexOf(prefix);
    const head = hostSource.slice(Math.max(0, i - 60), i);
    assert.match(head, /traceOps\(`/, `${prefix} 不在 traceOps 里（#97 的分级口径：常态走 debug，失败才 warn）`);
  }
});

run('隐私：留痕里没有任何草稿或正文字段（只有标签与毫秒数）', () => {
  for (const call of [...hostSource.matchAll(/languageTraceKeys\(\{[^}]*\}\)/g)].map((m) => m[0])) {
    assert.doesNotMatch(call, /draft|text|suggestion\./, `新键里出现了正字样字段：${call}`);
  }
});

if (failed > 0) {
  console.error(`\n❌ 语言判定留痕冒烟：${failed} 条断言失败`);
  process.exit(1);
}
console.log('\n✅ language-trace 12 组断言全部通过');
