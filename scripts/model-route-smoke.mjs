#!/usr/bin/env node
// #47 模型路由解析的判别冒烟：`routeOf` / `deploymentRoute` 是纯函数，直接喂形状。
//
// ## 这条要钉住的那件事（用户报的现场）
// 「停顿后的补全完全不触发」的真相是：它在触发，但每次调用都死在模型路由层 ——
// 旧 `routeOf` 在未配置时**继承该会话最近一次请求的路由**，于是主会话切到一条 401 的路由后，
// 建议与补全全部跟着漂过去，全线哑掉而界面无感知。
//
// ## 为什么是纯函数断言而不是真回合
// 判据 ①②③④ 全是"给什么形状的配置、解析出哪条路由"，用真宿主反而会把"会话路由"与
// "部署默认"混成同一个来源（真宿主里主会话的路由往往就等于部署默认 ⇒ 测不出区别）。
// 真回合那条判据（主会话在坏路由上、插件显式配好 ⇒ 补全仍成功）由 GUI 侧验，不在这里冒充。
//
// ## 导入的是 lib/ 不是 src/（本仓红线：冒烟跑的是入库产物）
// 用法：node scripts/model-route-smoke.mjs
import assert from 'node:assert/strict';
import { deploymentRoute, routeOf } from '../lib/generate.js';

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${String(error.message).split('\n')[0]}`);
  }
};

/** 造一条会话：`header` 给它当"最近一次请求的路由"；顺便记录有没有被读过。 */
const fakeSession = (header) => {
  const box = { readCount: 0 };
  return {
    box,
    requestHeader: () => { box.readCount += 1; return header === undefined ? undefined : { config: header }; },
  };
};
// 用户现场那条坏路由（Command Code，401）
const BAD = { provider: 'commandcode', model: 'cc-sonnet' };
// 部署默认（GUI 头部选的那条）
const DEPLOY = { provider: 'qoder-route', model: 'qfmodel' };
// 插件里显式配的
const EXPLICIT = { provider: 'deepseek-official', model: 'deepseek-chat' };

check('① 显式配置 ⇒ 用它，且不去读会话路由（漂不过去）', () => {
  const s = fakeSession(BAD);
  const got = routeOf(s, { provider: EXPLICIT.provider, model: EXPLICIT.model, inheritSessionRoute: false }, DEPLOY);
  assert.deepEqual(got, EXPLICIT);
  assert.equal(s.box.readCount, 0, '显式配置时读了 session.requestHeader() ⇒ 还是会漂');
});

check('② 未配置 ⇒ 用**部署默认**，并且不读会话路由（这就是修好的那条）', () => {
  const s = fakeSession(BAD);
  const got = routeOf(s, { provider: '', model: '', inheritSessionRoute: false }, DEPLOY);
  assert.deepEqual(got, DEPLOY, `未配置时没跟随部署默认：${JSON.stringify(got)}`);
  assert.equal(s.box.readCount, 0,
    '默认关继承时仍去读了会话路由 ⇒ 用户主会话换到坏路由，补全会跟着全线哑掉（#47 的原始故障）');
});

check('②b 空白串也算未配置（schema 用 default("")，trim 后判空）', () => {
  const s = fakeSession(BAD);
  assert.deepEqual(routeOf(s, { provider: '   ', model: '  ' }, DEPLOY), DEPLOY);
});

check('③ 半配置 ⇒ 抛错，且错误里说清"两个一起配"', () => {
  const s = fakeSession(BAD);
  for (const cfg of [{ provider: 'x', model: '' }, { provider: '', model: 'y' }]) {
    assert.throws(() => routeOf(s, cfg, DEPLOY), /must be configured together/,
      `半配置没抛错：${JSON.stringify(cfg)}`);
  }
});

check('④ inheritSessionRoute=true ⇒ 才读会话路由；读不到时抛错并点名这个开关', () => {
  const s = fakeSession(BAD);
  assert.deepEqual(routeOf(s, { provider: '', model: '', inheritSessionRoute: true }, DEPLOY), BAD,
    '开关开了却没继承会话路由');
  assert.equal(s.box.readCount, 1, '继承路径应当恰好读一次');
  const empty = fakeSession(undefined);
  assert.throws(
    () => routeOf(empty, { provider: '', model: '', inheritSessionRoute: true }, undefined),
    /inheritSessionRoute is on/,
    '开了继承但没有会话路由 ⇒ 必须点名开关，不能报成"没配 provider/model"',
  );
});

// 开关开着就必须先试会话路由 —— 否则部署默认几乎总有值，这个开关在真实部署里是个死键。
// （我第一版把优先级写成"部署默认永远压住继承"，于是这条与上一条互相矛盾 ⇒ 两条不可能同时绿，
//   是测试自相矛盾，不是实现错。矛盾当场暴露 = 这两条断言写对了。）
check('④b 开关开着 ⇒ 会话路由优先于部署默认（开关必须真的生效）', () => {
  const s = fakeSession(BAD);
  assert.deepEqual(routeOf(s, { provider: '', model: '', inheritSessionRoute: true }, DEPLOY), BAD);
  assert.equal(s.box.readCount, 1);
});

check('④c 开关开着但会话没路由 ⇒ 退到部署默认（不因开关而全线失败）', () => {
  const s = fakeSession(undefined);
  assert.deepEqual(routeOf(s, { provider: '', model: '', inheritSessionRoute: true }, DEPLOY), DEPLOY);
});

check('⑤ 三条来源全没有 ⇒ 抛错，且错误给出两条出路（不许静默降级）', () => {
  const s = fakeSession(BAD);
  let message = '';
  try {
    routeOf(s, { provider: '', model: '' }, undefined);
  } catch (error) { message = String(error.message); }
  assert.match(message, /no model route available/, `报错开头不对：${message}`);
  assert.match(message, /inheritSessionRoute/, '错误里必须点名那个开关，否则用户不知道该开它');
  assert.equal(s.box.readCount, 0, '默认关时即使报错也不该读过会话路由');
});

check('⑥ deploymentRoute：服务在就取，形状不对/没有/抛错一律算"没有"', () => {
  assert.deepEqual(deploymentRoute({ get: () => ({ get: () => ({ provider: ' p ', model: 'm' }) }) }),
    { provider: 'p', model: 'm' }, '没 trim 或没读到');
  for (const ctx of [
    { get: () => undefined },
    { get: () => ({ get: () => undefined }) },
    { get: () => ({ get: () => ({ provider: '', model: 'm' }) }) },
    { get: () => ({ get: () => ({ provider: 42, model: null }) }) },
    { get: () => ({ get: () => { throw new Error('boom'); } }) },
    {},
  ]) {
    assert.equal(deploymentRoute(ctx), undefined, `该判"没有部署默认"：${JSON.stringify(Object.keys(ctx))}`);
  }
});

check('⑦ 隐私/形状：解析结果只有 provider/model 两个字段（不带会话 id、不带正文）', () => {
  const got = routeOf(fakeSession(BAD), { provider: '', model: '' }, DEPLOY);
  assert.deepEqual(Object.keys(got).sort(), ['model', 'provider'], `多带了字段：${Object.keys(got)}`);
});

console.log(`\n${failed === 0 ? '✅' : '❌'} model-route-smoke: ${failed === 0 ? '路由解析判据全过（继承已默认关闭）' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
