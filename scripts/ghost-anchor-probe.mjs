#!/usr/bin/env node
/**
 * 幽灵锚点**真浏览器 + 真产物**探针：草稿以「引用文本」收尾时，灰字必须接在**看得见的**
 * 收尾之后，而不是接在文本节点的排版末端。
 *
 * ## 这条脚本存在的理由
 *
 * DSH 的引用是内联原子：引用 chip 与 quote 都是 contenteditable=false 的 inline-flex 盒子，
 * 文字外面套着 max-width + overflow:hidden（chip 240px、quote min(80%,300px)）。于是：
 *
 *  - 文本节点的排版宽度是**未截断**的自然宽度；
 *  - 用户看得见的收尾是**裁剪框**的右缘。
 *
 * 旧锚点（最后一个文本节点的末字符）量的是前者 ⇒ 灰字被画到可见收尾右侧几百像素处；
 * 若 chip 此刻还没有文本节点（装饰器 portal 未到），它会停在 chip **之前**，直接压在
 * 引用文本上——就是用户报「幽灵和引用文本重叠」的形态。
 *
 * 复刻宿主真实 DOM/CSS（取自 dsh-client-ui-conversation 与 primitives 的编译产物），
 * 加载**真实 lib/client.js**、截获模块私有的 GhostOverlay，调真 attach()/show()，
 * 再与「构造时就知道的收尾节点」比位置。
 *
 * ## 反例守卫
 *
 * --bundle <path> 指到修复前的产物时，C / E / F / G 四个场景必须变红；否则这条探针没有
 * 鉴别力（G 是「装饰器 portal 晚到」：先空盒子、后补 label，靠结构观察者重排）。
 *
 * 用法：node scripts/ghost-anchor-probe.mjs [--bundle lib/client.js] [--chrome <path>]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  record('真浏览器锚点探针（需要 Chrome + 构建产物）', STATUS.NC,
    '缺前置：CHROME_BIN 或 ' + bundlePath + '（先 npm run build）');
  process.exit(0);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 最小 CDP 客户端（Node 自带 WebSocket，零依赖；与 regen-pending-smoke 同一套）。 */
const cdp = async () => {
  const dir = join(tmpdir(), 'sg-anchor-' + Date.now());
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

const SUFFIX = '所以这条断言要同时落在安装脚本与镜像构建阶段，否则换个入口就绕过去了。';
const LONG_LABEL = '把生产环境的启动脚本与镜像构建拆开的那次讨论（会话标题很长很长很长很长很长）';
const LONG_QUOTE = '克隆后的系统身份凭证必须在安装脚本与镜像构建阶段重建，否则换个入口就绕过去了，而且这条断言要落在两处。';

const SCENARIOS = [
  { id: 'A-text', label: '纯文本收尾（对照）',
    paragraphs: [[{ kind: 'text', text: '第一步先起服务；第二步写断言' }]],
    draft: '第一步先起服务；第二步写断言' },
  { id: 'B-chip-short', label: '短引用 chip + 后续文字',
    paragraphs: [[{ kind: 'text', text: '第二步引用 ' }, { kind: 'chip', label: 'start-box-service' }, { kind: 'text', text: ' 然后再跑一次' }]],
    draft: '第二步引用 @start-box-service 然后再跑一次' },
  { id: 'C-chip-clipped', label: '长引用 chip（标签被 240px 截断）收尾',
    paragraphs: [[{ kind: 'text', text: '第二步引用 ' }, { kind: 'chip', label: LONG_LABEL }]],
    draft: '第二步引用 @' + LONG_LABEL },
  { id: 'D-chip-then-text', label: '长引用 chip 之后还有文字',
    paragraphs: [[{ kind: 'text', text: '第二步引用 ' }, { kind: 'chip', label: LONG_LABEL }, { kind: 'text', text: ' 然后再跑一次' }]],
    draft: '第二步引用 @' + LONG_LABEL + ' 然后再跑一次' },
  { id: 'E-quote-clipped', label: '长引用 quote（300px 截断）收尾',
    paragraphs: [[{ kind: 'text', text: '参考 ' }, { kind: 'quote', text: LONG_QUOTE }]],
    draft: '参考 ' + LONG_QUOTE },
  { id: 'F-chip-no-text', label: '有盒子、无文本节点的引用 chip 收尾',
    paragraphs: [[{ kind: 'text', text: '第二步引用 ' }, { kind: 'chip', label: '', bare: true, minWidth: '220px' }]],
    draft: '第二步引用 @某个会话' },
  { id: 'G-late-portal', label: '装饰器 portal 晚到（先空盒子，再补 label）', latePortal: true,
    label2: LONG_LABEL, draft: '第二步引用 @' + LONG_LABEL },
];

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
    await b.evaluate(readFileSync(join(REPO, 'scripts/ghost-anchor-probe.page.js'), 'utf8'));
    for (const s of SCENARIOS) {
      await b.evaluate('window.__anchorSetup()');
      await b.evaluate('window.__spec = ' + JSON.stringify({ paragraphs: s.paragraphs, draft: s.draft, suffix: SUFFIX, label: s.label2 }));
      const r = s.latePortal === true
        ? await b.evaluate('window.__probeLatePortal(window.__spec)')
        : await b.evaluate('window.__probeAnchor(window.__spec)');
      if (r === null || r === undefined || r.fatal !== undefined) {
        record(s.id + '｜' + s.label, STATUS.FAIL, r === null || r === undefined ? 'null' : r.fatal);
        continue;
      }
      const shapeOk = r.reject === null && r.display === 'block';
      const dx = r.firstLine === null || r.expected === null ? null : Math.round((r.firstLine.left - r.expected.right) * 100) / 100;
      const detail = '收尾=' + (r.expected === null ? 'n/a' : r.expected.right + '（' + r.expected.via + '）')
        + '，灰字首行 left=' + (r.firstLine === null ? 'n/a' : r.firstLine.left)
        + '，dx=' + dx + (r.reject === null ? '' : '，reject=' + r.reject);
      if (!shapeOk) {
        record(s.id + '｜灰字真的画出来了（过自检）', STATUS.FAIL, detail);
      } else if (dx === null || Math.abs(dx) > 1.5) {
        record(s.id + '｜灰字接在可见收尾之后（' + s.label + '）', STATUS.FAIL, detail);
      } else {
        record(s.id + '｜灰字接在可见收尾之后（' + s.label + '）', STATUS.PASS, detail);
      }
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
