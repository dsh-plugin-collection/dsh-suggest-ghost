#!/usr/bin/env node
// #116 模型目录路由的判别冒烟：安全口径要判成"构造上拿不到"，不是"这次响应里恰好没有"。
//
// ## 为什么不能只写"curl 一遍看有没有敏感串"
// 那种判据只能证明**这一次**没有：换一行代码、宿主给 provider 行加个 `lastSession` 字段，
// 它就悄悄失效了。所以这里三条叠着用：
//   ① **白名单投影**：投毒测试 —— 源返回的行里塞满 draft/sessionId/热表短语，
//      响应里必须一个都没有（投影只放行 id/name，所以这不是"我们记得没写"，是结构上写不出去）。
//   ② **访问记录**：handler 只被允许调用 sources 的 providers/models 两个方法；
//      用 Proxy 记录属性访问，多碰一个键就红（比"读结果"强：读了但没用也照样红）。
//   ③ **生产接线的静态闸**：`lib/index.js` 里那段接线不得引用 session/hotness/_push/_hot/draft，
//      并且数据源只能是 llm 服务的两个方法 —— 防的是"以后有人顺手把会话状态接进这个 handler"。
//
// ## 导入的是 lib/ 不是 src/（本仓红线）
// 用法：node scripts/model-catalog-smoke.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CATALOG_MAX_ROWS,
  MODEL_OPTIONS_PATH,
  createModelCatalogHandler,
  normalizeCatalogRows,
  sanitizeProviderParam,
} from '../lib/model-catalog.js';

let failed = 0;
const check = (name, fn) => {
  try {
    const r = fn();
    if (r instanceof Promise) return r.then(() => { console.log(`  ✓ ${name}`); },
      (e) => { failed += 1; console.log(`  ✗ ${name}\n      ${String(e.message).split('\n')[0]}`); });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

/** 假 res：记录状态、头与体。 */
const fakeRes = () => {
  const box = { status: 0, headers: {}, body: undefined };
  return {
    box,
    writeHead(status, headers) { box.status = status; box.headers = headers ?? {}; },
    end(body) { box.body = body; },
  };
};
const call = async (handler, method, url) => {
  const res = fakeRes();
  await handler({ method, url }, res);
  // handler 内部是 void(promise.then(...)) ⇒ 等一拍微任务
  await new Promise((r) => setTimeout(r, 0));
  return res.box;
};

const PROVIDERS = [{ id: 'qoder-route', name: 'Qoder Route' }, { id: 'deepseek-official', name: 'DeepSeek' }];
const MODELS = [{ id: 'qfmodel', name: 'Qoder Model' }];

// ── 1. 白名单投影本身 ──────────────────────────────────────────────────────
check('1a 投影只放行 id/name：多出来的键一律丢弃', () => {
  const rows = normalizeCatalogRows([
    { id: 'a', name: 'A', draft: '用户的草稿片段', sessionId: 'session-abc', lastUsedAt: 1 },
    { id: 'b', name: 'B', hot: ['把构建脚本改一下'], suggestionText: '一条建议正文' },
  ]);
  assert.deepEqual(rows, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]);
  assert.equal(Object.keys(rows[0]).sort().join(','), 'id,name');
});

check('1b 非法行整条丢弃（不做部分保留）；name 缺失退回 id', () => {
  const rows = normalizeCatalogRows([
    null, 'x', 42, { id: '', name: '空 id' }, { name: '没 id' },
    { id: 'has space', name: 'id 带空格' }, { id: 'ok', name: '  ' },
  ]);
  assert.deepEqual(rows, [{ id: 'ok', name: 'ok' }], `实际=${JSON.stringify(rows)}`);
});

check('1c 去重 + 稳定排序 + 上限钉死', () => {
  const many = Array.from({ length: CATALOG_MAX_ROWS + 50 }, (_, i) => ({ id: `z${String(i)}`, name: `N${i}` }));
  const rows = normalizeCatalogRows([...many, { id: 'z0', name: '重复' }]);
  assert.equal(rows.length, CATALOG_MAX_ROWS, `没截断：${rows.length}`);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, '没去重');
  const ids = normalizeCatalogRows([{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }]).map((r) => r.id);
  assert.deepEqual(ids, ['a', 'b'], '没排序（排序保证两次响应可比）');
});

check('1d Map 形状也吃（宿主两代返回形状不同）', () => {
  const m = new Map([['p1', { id: 'p1', name: 'One' }]]);
  assert.deepEqual(normalizeCatalogRows(m), [{ id: 'p1', name: 'One' }]);
});

check('1e ?models= 的入参过同一套字符集约束（不合法就当没传）', () => {
  assert.equal(sanitizeProviderParam('qoder-route'), 'qoder-route');
  for (const bad of ['', '   ', 'a b', '../../etc/passwd', 'x'.repeat(200), 'qoder\n-route']) {
    assert.equal(sanitizeProviderParam(bad), null, `该判不合法：${JSON.stringify(bad.slice(0, 20))}`);
  }
});

// ── 2. handler 行为 ────────────────────────────────────────────────────────
await check('2a GET → 恰好 {version,providers}；?models= → 恰好 {version,models}', async () => {
  const handler = createModelCatalogHandler({ sources: { providers: () => PROVIDERS, models: () => MODELS } });
  const a = await call(handler, 'GET', MODEL_OPTIONS_PATH);
  assert.equal(a.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(a.body)).sort(), ['providers', 'version']);
  assert.equal(a.headers['cache-control'], 'no-store');
  const b = await call(handler, 'GET', `${MODEL_OPTIONS_PATH}?models=qoder-route`);
  assert.deepEqual(Object.keys(JSON.parse(b.body)).sort(), ['models', 'version']);
});

await check('2b 不回显 provider 参数（少一个能被请求方控制的字段）', async () => {
  const handler = createModelCatalogHandler({ sources: { providers: () => [], models: () => [] } });
  const box = await call(handler, 'GET', `${MODEL_OPTIONS_PATH}?models=evil-canary`);
  assert.ok(!box.body.includes('evil-canary'), `响应回显了入参：${box.body}`);
});

await check('2c 非 GET/HEAD → 405 且 allow 头在', async () => {
  const handler = createModelCatalogHandler({ sources: { providers: () => PROVIDERS, models: () => MODELS } });
  const box = await call(handler, 'POST', MODEL_OPTIONS_PATH);
  assert.equal(box.status, 405);
  assert.equal(box.headers.allow, 'GET, HEAD');
});

await check('2d 投毒测试：源返回带会话派生数据的行，响应里必须一个都没有', async () => {
  const poisonedProviders = [
    { id: 'p1', name: 'P1', lastSessionId: 'session-1d80feeb', draft: '这个插件怎么构建' },
  ];
  const poisonedModels = [
    { provider: 'p1', id: 'm1', name: 'M1', suggestionText: '把构建脚本改一下', hotPhrase: '跑一下冒烟' },
  ];
  const handler = createModelCatalogHandler({
    sources: { providers: () => poisonedProviders, models: () => poisonedModels },
  });
  const canaries = ['session-1d80feeb', '这个插件怎么构建', '把构建脚本改一下', '跑一下冒烟', 'suggestionText', 'lastSessionId', 'hotPhrase'];
  for (const url of [MODEL_OPTIONS_PATH, `${MODEL_OPTIONS_PATH}?models=p1`]) {
    const box = await call(handler, 'GET', url);
    for (const canary of canaries) {
      assert.ok(!box.body.includes(canary), `${url} 的响应里出现了 ${canary}：${box.body}`);
    }
  }
});

await check('2e 访问记录：handler 只许碰 sources 的 providers/models 两个方法', async () => {
  const touched = new Set();
  const recording = (obj, tag) => new Proxy(obj, {
    get(target, prop) {
      touched.add(`${tag}.${String(prop)}`);
      if (prop !== 'providers' && prop !== 'models' && prop !== 'then') {
        throw new Error(`handler 试图读取源的未知成员 "${String(prop)}"`);
      }
      return target[prop];
    },
  });
  const sources = recording({ providers: () => PROVIDERS, models: () => MODELS }, 'sources');
  const handler = createModelCatalogHandler({ sources });
  await call(handler, 'GET', MODEL_OPTIONS_PATH);
  await call(handler, 'GET', `${MODEL_OPTIONS_PATH}?models=qoder-route`);
  const offenders = [...touched].filter((k) => k !== 'sources.providers' && k !== 'sources.models');
  assert.deepEqual(offenders, [], `handler 碰了不该碰的成员：${JSON.stringify(offenders)}`);
});

await check('2f 源抛错 → 该段退化成空数组、200、响应体不含错误文本', async () => {
  const handler = createModelCatalogHandler({
    sources: {
      providers: () => { throw new Error('provider exploded with session-abc in message'); },
      models: async () => { throw new Error('boom'); },
    },
    logger: { warn: () => undefined },
  });
  const a = await call(handler, 'GET', MODEL_OPTIONS_PATH);
  assert.equal(a.status, 200);
  assert.deepEqual(JSON.parse(a.body).providers, []);
  assert.ok(!a.body.includes('session-abc') && !a.body.includes('exploded'),
    `错误文本进了响应体（这条路由不经鉴权，不能把宿主错误反射出去）：${a.body}`);
});

// ── 3. 生产接线的构造性静态闸 ──────────────────────────────────────────────
await check('3a 接线只接 llm 的两个方法，不引用任何会话派生数据', () => {
  const src = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8');
  // 锚点选 **listProviders** 而不是 MODEL_OPTIONS_PATH：后者会先出现在 import 行上，
  // 于是 lastIndexOf('ctx.inject', at) 会退回到**上一个** inject 块（我第一版就被这个
  // 假锚点骗成"源没接宿主"，其实是取错了段落）。
  const at = src.indexOf('listProviders');
  assert.ok(at > 0, 'lib/index.js 里找不到目录路由的接线（产物没重建？）');
  const from = src.lastIndexOf('ctx.inject', at);
  // 块尾按**产物实际缩进**找（tsc 出来是 4 空格，源码是 2 空格）—— 别用固定字符窗口：
  // 窗口型锚点在本仓已经坑过一次（payload-split 的 from + 6000）。
  const ends = ['\n    });', '\n  });', '\n});'].map((t) => src.indexOf(t, at)).filter((i) => i > at);
  assert.ok(from > 0 && ends.length > 0, `接线块边界取不出来（from=${from} at=${at}）`);
  const block = src.slice(from, Math.min(...ends));
  assert.ok(block.includes('listProviders'), 'providers 源没接宿主 listProviders');
  assert.ok(block.includes('listModels'), 'models 源没接宿主 listModels');
  // 反向：这段接线里不许出现任何会话派生的数据源
  // 只扫**代码**，不扫注释：这段接线的注释里本来就写着"不许接 draft / sessionId"，
  // 拿原文去匹配会让闸在自己身上误报（第一版就是这样，红得毫无信息量）。
  const code = block.split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  const banned = ['hotness', '_push', '_hot', 'snapshot(', 'draft', 'sessionId', 'sessions.'];
  const hits = banned.filter((b) => code.includes(b));
  assert.deepEqual(hits, [], `接线里出现了会话派生的引用：${JSON.stringify(hits)}\n${block.slice(0, 400)}`);
});

check('3b 目录模块本身零宿主依赖（纯函数，拿不到会话面）', () => {
  const src = readFileSync(join(process.cwd(), 'lib', 'model-catalog.js'), 'utf8');
  assert.ok(!/require\(|from ['"]@deepseek/.test(src),
    `model-catalog 引入了宿主包 ⇒ 它就可能拿到会话面：\n${src.split('\n').filter(l => /require\(|from /.test(l)).join('\n')}`);
});

// ── 4) 档位分支（#50）：同样的三层口径 ─────────────────────────────
await check('4a 档位投影：只放行 id/name/description，投毒字段一个都不吐', async () => {
  const handler = createModelCatalogHandler({ sources: {
    providers: () => [], models: () => [],
    efforts: () => ({
      id: 'qfmodel', draft: 'SECRET-DRAFT', sessionId: 'session-abc',
      reasoning: {
        defaultEffort: 'medium',
        efforts: [
          { id: 'low', name: 'Low', draft: 'SECRET', sessionId: 'session-abc' },
          { id: 'medium', name: 'Med', description: '中' },
        ],
      },
    }),
  } });
  const box = await call(handler, 'GET', `${MODEL_OPTIONS_PATH}?efforts=qoder-route|qfmodel`);
  assert.equal(box.status, 200);
  const body = JSON.parse(box.body);
  assert.deepEqual(body.efforts.map((e) => e.id), ['low', 'medium']);
  assert.equal(body.defaultEffort, 'medium');
  assert.ok(!/SECRET|session-|draft/.test(box.body), `泄漏了会话派生数据：${box.body}`);
});

await check('4b 档位：源抛错 ⇒ 空数组 + 200（不 500、响应体不带错误文本）', async () => {
  const handler = createModelCatalogHandler({ sources: {
    providers: () => [], models: () => [],
    efforts: () => { throw new Error('boom SECRET'); },
  } });
  const box = await call(handler, 'GET', `${MODEL_OPTIONS_PATH}?efforts=p|m`);
  assert.equal(box.status, 200);
  assert.deepEqual(JSON.parse(box.body).efforts, []);
  assert.ok(!box.body.includes('boom'), `响应体带了错误文本：${box.body}`);
});

await check('4c 档位：参数不合法 ⇒ 退化成 provider 目录（不 500、不调用源）', async () => {
  let called = 0;
  const handler = createModelCatalogHandler({ sources: {
    providers: () => PROVIDERS, models: () => [],
    efforts: () => { called += 1; return null; },
  } });
  for (const bad of ['../../etc|', '|', 'p|', '|m', 'p|../../etc']) {
    const box = await call(handler, 'GET', `${MODEL_OPTIONS_PATH}?efforts=${encodeURIComponent(bad)}`);
    assert.equal(box.status, 200, `${bad} → ${box.status}`);
    assert.ok(JSON.parse(box.body).providers !== undefined, `${bad} 没退化成 providers：${box.body}`);
  }
  assert.equal(called, 0, '参数不合法时仍然调用了档位源');
});

await check('4d 访问记录：档位分支只碰 efforts，不碰 providers/models', async () => {
  const touched = new Set();
  const base = {
    providers: () => [], models: () => [],
    efforts: () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }),
  };
  const sources = new Proxy(base, {
    get(target, key) { if (typeof key === 'string') touched.add(key); return target[key]; },
  });
  const handler = createModelCatalogHandler({ sources });
  const box = await call(handler, 'GET', `${MODEL_OPTIONS_PATH}?efforts=p|m`);
  assert.deepEqual([...touched].sort(), ['efforts'], `多碰了：${[...touched].join(',')}`);
  assert.deepEqual(JSON.parse(box.body).efforts.map((e) => e.id), ['low']);
});

console.log(`\n${failed === 0 ? '✅' : '❌'} model-catalog-smoke: ${failed === 0 ? '目录路由判据全过（构造性安全口径）' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
