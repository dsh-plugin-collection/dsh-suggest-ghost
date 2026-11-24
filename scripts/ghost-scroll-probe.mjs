#!/usr/bin/env node
/**
 * 幽灵「滚动不重排」探针（真产物 + 真 Chromium）。
 *
 * ## 这条脚本存在的理由
 *
 * 用户报的现象是「建议有多行时，在输入框里向下滚动文字会抖」。根因不在几何——overlay 挂在
 * **被滚动的内容**里，滚动时它和正文一起位移（见 GhostOverlay 类注释的实测表格）——而在
 * onScroll 的回调里：旧实现每收到一个 scroll 事件就跑一遍 alignAndVerify()，而 align() 是
 * 「先写样式再测量」，等于**每帧强制一次同步布局**；多行灰字正是那块最贵的被布局元素。
 *
 * 真 composer 实测（DSH 0.2.2-rc.3 + 本插件真产物，滚动 2.2s）：
 *   带幽灵：帧间隔 p95 23.5ms、峰值 32.5ms；同页去掉幽灵：p95 17.4ms、峰值 18.0ms。
 * ⇒ 掉帧就是用户看到的「抖」。修掉之后带幽灵的 p95 回到 17.4ms。
 *
 * 帧间隔不适合当 CI 判据（机器噪声大），所以这里钉**行为**：
 *
 *  1. **跟手**：灰字与草稿末行的相对位移在整个滚动范围内保持不变；
 *  2. **滚动里不重排**：往 overlay 的 inline top 写一个哨兵值，再滚一下 —— 旧实现会把它
 *     覆盖回算出来的值（这就是「每帧一次强制布局」的证据），修好之后哨兵原地不动。
 *
 * 反例守卫：--bundle 指到修复前的产物时，第 2 条必须变红。
 *
 * 用法：node scripts/ghost-scroll-probe.mjs [--bundle lib/client.js] [--chrome <path>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const STATUS = { PASS: 'PASS', FAIL: 'FAIL', NC: 'NOT-COVERED' };
const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  const mark = status === STATUS.PASS ? '✅' : status === STATUS.FAIL ? '❌' : '⚪';
  console.log(mark + ' [' + status + '] ' + name + (detail ? '\n      实测：' + detail : ''));
};

const CHROME = [
  flag('--chrome') ?? '',
  process.env.CHROME_BIN ?? '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'),
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].filter(p => p !== '').find(p => existsSync(p));

const bundlePath = resolve(REPO, flag('--bundle') ?? 'lib/client.js');

if (CHROME === undefined || !existsSync(bundlePath)) {
  record('真浏览器滚动探针（需要 Chrome + 构建产物）', STATUS.NC,
    '缺前置：CHROME_BIN 或 ' + bundlePath + '（先 npm run build）');
  process.exit(0);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 最小 CDP 客户端（Node 自带 WebSocket，零依赖；与 regen-pending-smoke 同一套）。 */
const cdp = async () => {
  const dir = join(tmpdir(), 'sg-scroll-' + Date.now());
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=0', '--user-data-dir=' + dir, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  const portFile = join(dir, 'DevToolsActivePort');
  for (let k = 0; k < 150 && !existsSync(portFile); k += 1) await sleep(100);
  if (!existsSync(portFile)) {
    proc.kill('SIGKILL');
    throw new Error('Chromium 没起来（等不到 DevToolsActivePort）：' + CHROME);
  }
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data.toString());
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error !== undefined) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg.result);
    }
  };
  const send = (method, params) => new Promise((res, rej) => {
    const n = ++id;
    pending.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params: params ?? {} }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails !== undefined) {
      throw new Error('页内异常：' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    }
    return r.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await evaluate('document.open();document.write("<html><head></head><body></body></html>");document.close();');
  const close = () => {
    try { ws.close(); } catch { /* noop */ }
    proc.kill('SIGKILL');
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* 留给系统清理 */ }
  };
  return { evaluate, close };
};

const MARKER = '\t\treturn module.exports;';

const injectBundle = (bundle) => {
  const occurrences = bundle.split(MARKER).length - 1;
  if (occurrences !== 1) throw new Error('bundle 收尾标记出现 ' + occurrences + ' 次（期望 1）');
  const patched = bundle.replace(MARKER, '\t\tglobalThis.__GhostOverlay = GhostOverlay;\n' + MARKER);
  return '(() => {\n'
    + '  window.__ModuleLoader__ = { load: (def) => {\n'
    + '    const lazy = () => new Proxy(function(){}, { get: () => lazy(), apply: () => lazy(), construct: () => ({}) });\n'
    + '    return def.factory(() => lazy());\n'
    + '  } };\n'
    + '  const s = document.createElement("script");\n'
    + '  s.textContent = ' + JSON.stringify(patched) + ';\n'
    + '  document.head.appendChild(s);\n'
    + '  return typeof globalThis.__GhostOverlay === "function" ? "ok" : "not-a-class";\n'
    + '})()';
};

const LINES = [
  '第一行：把流水线拆成两步；',
  '第二行：安装脚本只做安装；',
  '第三行：镜像构建单独一条入口；',
  '第四行：断言落在两处；',
  '第五行：克隆检测不能只写进启动脚本；',
  '第六行：否则换个入口就绕过去了；',
  '第七行：这条也要写进文档；',
  '第八行：再补一条回归断言；',
  '第九行：最后收口。',
];
const SUFFIX = '所以这一段的建议会折成很多行，用来观察滚动时灰字是否跟着正文一起走。再多写几句，确保它至少四行。再补一句让它更长一些，这样滚动范围明显。';

const main = async () => {
  console.log('（引擎：' + CHROME + '）');
  console.log('（产物：' + bundlePath + '）');
  const b = await cdp();
  try {
    const injected = await b.evaluate(injectBundle(readFileSync(bundlePath, 'utf8')));
    if (injected !== 'ok') {
      record('截获真实产物里的 GhostOverlay', STATUS.FAIL, String(injected));
      return;
    }
    await b.evaluate(readFileSync(join(REPO, 'scripts/ghost-scroll-probe.page.js'), 'utf8'));
    const setup = await b.evaluate('window.__scrollSetup(' + JSON.stringify(LINES) + ', ' + JSON.stringify(SUFFIX) + ')');
    if (setup === null || setup === undefined || setup.display !== 'block') {
      record('灰字先画出来（过自检）', STATUS.FAIL, JSON.stringify(setup));
      return;
    }
    const max = setup.sh - setup.ch;
    const base = await b.evaluate('window.__scrollSample()');
    let worst = 0;
    const seen = [];
    for (let st = 0; st <= max; st += 10) {
      await b.evaluate('window.__scrollTo(' + st + ')');
      await sleep(16);
      const s = await b.evaluate('window.__scrollSample()');
      if (s === null) continue;
      seen.push(s);
      if (base !== null && s.dy !== null && base.dy !== null) {
        worst = Math.max(worst, Math.abs(s.dy - base.dy));
      }
    }
    const hidden = seen.filter(s => s.display !== 'block' || s.reject !== null);
    console.log('  （滚动 ' + seen.length + ' 步，scrollTop 0..' + max + '，dy 基线 ' + (base === null ? 'n/a' : base.dy) + '）');
    if (hidden.length > 0) {
      record('滚动期间灰字一直画着（不 hide、不 reject）', STATUS.FAIL,
        '首个异常：display=' + hidden[0].display + ' reject=' + String(hidden[0].reject) + ' st=' + hidden[0].st);
    } else {
      record('滚动期间灰字一直画着（不 hide、不 reject）', STATUS.PASS, 'display 恒 block、reject 恒 null');
    }
    if (worst > 1.5) {
      record('灰字跟着正文一起滚（相对位移恒定）', STATUS.FAIL, '最大漂移 ' + worst + 'px');
    } else {
      record('灰字跟着正文一起滚（相对位移恒定）', STATUS.PASS, '最大漂移 ' + worst + 'px');
    }

    const SENTINEL = '321.5px';
    await b.evaluate('window.__setSentinel(' + JSON.stringify(SENTINEL) + ')');
    const before = await b.evaluate('window.__scrollSample()');
    await b.evaluate('window.__scrollTo(0)');
    await sleep(50);
    await b.evaluate('window.__scrollTo(Math.min(40, ' + max + '))');
    await sleep(80);
    const after = await b.evaluate('window.__scrollSample()');
    if (after === null) {
      record('滚动不触发重排（inline top 不被改写）', STATUS.FAIL, '取样失败');
    } else if (after.styleTop !== SENTINEL) {
      record('滚动不触发重排（inline top 不被改写）', STATUS.FAIL,
        '哨兵 ' + SENTINEL + ' 被覆盖成 ' + after.styleTop + '（滚动里跑了 align）');
    } else {
      record('滚动不触发重排（inline top 不被改写）', STATUS.PASS,
        '哨兵原样保留（before=' + (before === null ? 'n/a' : before.styleTop) + ' after=' + after.styleTop + '）');
    }
  } finally {
    b.close();
  }
  const failed = results.filter(r => r.status === STATUS.FAIL).length;
  const passed = results.filter(r => r.status === STATUS.PASS).length;
  console.log('\n结果：' + passed + ' 通过, ' + failed + ' 失败');
  process.exit(failed === 0 ? 0 : 1);
};

main().catch((error) => {
  record('探针运行', STATUS.FAIL, String(error && error.message ? error.message : error).slice(0, 600));
  process.exit(1);
});
