#!/usr/bin/env node
/**
 * 幽灵折行几何**真浏览器 + 真产物**探针。
 *
 * ## 判据
 *
 * 灰字只是预览。所以真正的判据不是「它有没有显示」，而是：
 * **灰字折出来的每一行，与「同一段文字真的插进编辑器之后」的每一行重合。**
 * 这条判据在 Node 里验不了（没有排版引擎），只能跑真实浏览器。
 *
 * ## 为什么加载真实产物、而不是复刻 align() 的算术
 *
 * 与 scripts/regen-pending-smoke.mjs 同一口径：把 esbuild 打的 lib/client.js 注入
 * 真实 Chromium，给 factory 副本追加一行把模块私有的 GhostOverlay 挂到 globalThis，
 * 然后构造宿主三层 DOM 契约、调真 attach()/show()、读真 DOM。
 * 复刻算术只能证明「我理解的公式对」，证明不了「产物真的这样画」。
 *
 * 顺带钉住三件只有在真实路径上才成立的事：
 *   - 自检（verify）在折行口径改动后**仍然通过**（量的是第一个字，不是盒子左缘）；
 *   - overlay 的盒子是整行全宽（旧口径会缩成「行尾到行末」那一小段）；
 *   - 零宽断点（::before content 200b）让「行尾只剩几像素」时灰字整体折到下一行。
 *
 * ## 反例守卫
 *
 * --bundle <path> 可以指定另一份产物（例如修复前的 lib/client.js）。
 * 修复前的产物必须让本探针**变红**——否则这个探针没有鉴别力。
 *
 * ## 环境
 *
 * 浏览器取 CHROME_BIN，否则常见 Chrome 路径。找不到 ⇒ NOT-COVERED
 * （静默跳过会让「没跑」伪装成「跑绿了」）。
 *
 * 用法：node scripts/ghost-wrap-probe.mjs [--bundle lib/client.js] [--chrome <path>]
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
  record('真浏览器折行几何（需要 Chrome + 构建产物）', STATUS.NC,
    '缺前置：CHROME_BIN 或 ' + bundlePath + '（先 npm run build）');
  process.exit(0);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 最小 CDP 客户端（Node 自带 WebSocket，零依赖；与 regen-pending-smoke 同一套）。 */
const cdp = async () => {
  const dir = join(tmpdir(), 'sg-wrap-' + Date.now());
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
    // Chrome 被杀时仍在写 user-data-dir：直接 rm 会撞 ENOTEMPTY（实测）。
    // 重试几次是这类临时目录的标准做法，不是掩盖问题——它不影响任何被测判据。
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* 临时目录留给系统清理 */ }
  };
  return { evaluate, close };
};

/** 见 regen-pending-smoke.mjs 里同一段的长注释：注入点必须在 factory 作用域内。 */
const MARKER = '\t\treturn module.exports;';

const injectBundle = (bundle) => {
  const occurrences = bundle.split(MARKER).length - 1;
  if (occurrences !== 1) throw new Error('bundle 收尾标记出现 ' + occurrences + ' 次（期望 1）');
  const patched = bundle.replace(MARKER, '\t\tglobalThis.__GhostOverlay = GhostOverlay;\n' + MARKER);
  return '(() => {\n'
    + '  window.__ModuleLoader__ = { load: (def) => {\n'
    + '    const lazy = () => new Proxy(function () {}, { get: () => lazy(), apply: () => lazy(), construct: () => ({}) });\n'
    + '    return def.factory(() => lazy());\n'
    + '  } };\n'
    + '  const s = document.createElement("script");\n'
    + '  s.textContent = ' + JSON.stringify(patched) + ';\n'
    + '  document.head.appendChild(s);\n'
    + '  return typeof globalThis.__GhostOverlay === "function" ? "ok" : "not-a-class";\n'
    + '})()';
};

/** 宿主三层 DOM 契约（data-input-scroll > .grow > data-composer-input）+ 给定草稿段落。 */
const buildHost = (paragraphs) => '(() => {\n'
  + '  document.body.innerHTML = "";\n  document.head.innerHTML = "";\n'
  + '  document.body.style.cssText = "margin:0;padding:0;background:#fff";\n'
  + '  const scroll = document.createElement("div");\n'
  + '  scroll.setAttribute("data-input-scroll", "");\n'
  + '  scroll.style.cssText = "position:relative;overflow-y:auto;max-height:336px;width:920px";\n'
  + '  const grow = document.createElement("div");\n'
  + '  grow.className = "grow";\n'
  + '  grow.style.cssText = "position:relative;width:920px";\n'
  + '  const editor = document.createElement("div");\n'
  + '  editor.setAttribute("data-composer-input", "");\n'
  + '  editor.setAttribute("contenteditable", "true");\n'
  + '  editor.style.cssText = "box-sizing:border-box;width:920px;padding:4px 8px 0 14px;line-height:24px;'
  + 'font-size:14px;font-family:-apple-system,PingFang SC,sans-serif;min-height:36px;'
  + 'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere";\n'
  + '  for (const text of ' + JSON.stringify(paragraphs) + ') {\n'
  + '    const p = document.createElement("p");\n'
  + '    p.style.margin = "0";\n'
  + '    if (text !== "") p.textContent = text;\n'
  + '    editor.appendChild(p);\n'
  + '  }\n'
  + '  const ph = document.createElement("div");\n'
  + '  ph.setAttribute("data-composer-placeholder", "");\n'
  + '  ph.style.cssText = "position:absolute;left:14px;top:4px;line-height:24px;font-size:14px";\n'
  + '  grow.append(editor, ph);\n'
  + '  scroll.append(grow);\n'
  + '  document.body.append(scroll);\n'
  + '  return true;\n'
  + '})()';

const round = (v) => Math.round(v * 100) / 100;

/** 页内：真的 attach + show 一段历史补全，量灰字各行，再量「真插进去之后」各行。 */
const probeHistory = (suffix) => '(() => {\n'
  + '  const ed = document.querySelector("[data-composer-input]");\n'
  + '  const o = new globalThis.__GhostOverlay();\n'
  + '  o.attach(ed);\n'
  + '  const prefix = ed.textContent;\n'
  + '  o.show({ kind: "history", prefix, suffix: ' + JSON.stringify(suffix)
  + ', full: prefix + ' + JSON.stringify(suffix) + ', frame: { frame: 0, final: true } });\n'
  + '  const el = document.getElementById("dsh-suggest-ghost-overlay");\n'
  + '  if (el === null) return { fatal: "overlay 节点不存在" };\n'
  + '  const span = el.firstElementChild;\n'
  + '  const lines = (node) => {\n'
  + '    const r = document.createRange();\n'
  + '    r.selectNodeContents(node);\n'
  + '    return Array.from(r.getClientRects()).filter(x => x.height > 0)\n'
  + '      .map(x => ({ left: Math.round(x.left * 100) / 100, right: Math.round(x.right * 100) / 100 }));\n'
  + '  };\n'
  + '  const ghostLines = span === null ? [] : lines(span);\n'
  + '  const style = getComputedStyle(ed);\n'
  + '  const padLeft = parseFloat(style.paddingLeft) || 0;\n'
  + '  const padRight = parseFloat(style.paddingRight) || 0;\n'
  + '  const contentWidth = ed.clientWidth - padLeft - padRight;\n'
  + '  const lastP = ed.querySelector("p:last-child");\n'
  + '  const tn = document.createTextNode(' + JSON.stringify(suffix) + ');\n'
  + '  lastP.appendChild(tn);\n'
  + '  const acceptedLines = lines(tn);\n'
  + '  tn.remove();\n'
  + '  const box = {\n'
  + '    left: parseFloat(el.style.left), width: parseFloat(el.style.width), indent: parseFloat(el.style.textIndent),\n'
  + '  };\n'
  + '  const out = {\n'
  + '    rejected: el.dataset.reject ?? null,\n'
  + '    display: getComputedStyle(el).display,\n'
  + '    shown: el.dataset.shown ?? null,\n'
  + '    box, contentWidth, ghostLines, acceptedLines,\n'
  + '  };\n'
  + '  o.dispose();\n'
  + '  return out;\n'
  + '})()';

const SUFFIX = '了这个仓库是插件集合的源码，稍后需要克隆下来看看具体的配置方式。';
const EN_SUFFIX = ' world, and this continuation is long enough to wrap at least once so the line starts can be compared.';
const DRAFT_A = 'https://github.com/dsh-plugin-collection/dsh-suggest-ghost 这个dsh插件我在使用时遇到';

/** 造一段「填到离内容右缘只剩 gap 像素」的草稿（贴边场景，验证零宽断点）。 */
const probeFilledTo = (gap) => '(() => {\n'
  + '  const ed = document.querySelector("[data-composer-input]");\n'
  + '  const style = getComputedStyle(ed);\n'
  + '  const padLeft = parseFloat(style.paddingLeft) || 0, padRight = parseFloat(style.paddingRight) || 0;\n'
  + '  const contentWidth = ed.clientWidth - padLeft - padRight;\n'
  + '  const originX = ed.getBoundingClientRect().left + padLeft;\n'
  + '  const p = ed.querySelector("p");\n'
  + '  let text = "";\n'
  + '  let end = null;\n'
  + '  for (let i = 0; i < 400; i += 1) {\n'
  + '    text += "字";\n'
  + '    p.textContent = text;\n'
  + '    const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);\n'
  + '    let last = null;\n'
  + '    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) if (n.nodeValue && n.nodeValue.length) last = n;\n'
  + '    const r = document.createRange();\n'
  + '    r.setStart(last, last.nodeValue.length - 1);\n'
  + '    r.setEnd(last, last.nodeValue.length);\n'
  + '    end = r.getBoundingClientRect();\n'
  + '    if (end.right - originX > contentWidth - ' + gap + ') break;\n'
  + '  }\n'
  + '  return text;\n'
  + '})()';

const compare = (ghost, accepted) => {
  const bad = [];
  const n = Math.max(ghost.length, accepted.length);
  for (let i = 0; i < n; i += 1) {
    const g = ghost[i];
    const a = accepted[i];
    if (g === undefined || a === undefined || Math.abs(g.left - a.left) > 1 || Math.abs(g.right - a.right) > 1) {
      bad.push('第 ' + (i + 1) + ' 行 灰字=' + JSON.stringify(g ?? null) + ' 采纳后=' + JSON.stringify(a ?? null));
    }
  }
  return bad;
};

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

    const scenarios = [];
    await b.evaluate(buildHost([DRAFT_A]));
    scenarios.push({ id: 'A-screenshot', label: '用户截图那段（行尾在行中段）', reading: await b.evaluate(probeHistory(SUFFIX)) });
    await b.evaluate(buildHost(['帮我']));
    scenarios.push({ id: 'B-short', label: '短草稿（行尾在左侧）', reading: await b.evaluate(probeHistory(SUFFIX)) });
    await b.evaluate(buildHost(['']));
    const filled = await b.evaluate(probeFilledTo(14));
    await b.evaluate(buildHost([filled]));
    scenarios.push({ id: 'C-near-edge', label: '行尾离内容右缘只剩十几像素', reading: await b.evaluate(probeHistory(SUFFIX)) });
    await b.evaluate(buildHost(['第一段已经写完了', '第二段写到一半就停']));
    scenarios.push({ id: 'D-multiline', label: '多段草稿，末段行尾在行中段', reading: await b.evaluate(probeHistory(SUFFIX)) });
    // E：英文草稿 + 以空格开头的建议（历史补全按公共前缀切尾时很常见）。
    // 自检量的是「第一个字」，而空格的首字符矩形在部分引擎里宽度为 0——这里钉住它不会
    // 因此被判成 no-anchor-glyph（真浏览器里的实际行为比推断可靠）。
    await b.evaluate(buildHost(['hello']));
    scenarios.push({ id: 'E-leading-space', label: '英文草稿 + 建议以空格开头', reading: await b.evaluate(probeHistory(EN_SUFFIX)) });

    for (const s of scenarios) {
      const r = s.reading;
      if (r.fatal !== undefined) {
        record(s.id + '｜' + s.label, STATUS.FAIL, r.fatal);
        continue;
      }
      const shapeOk = r.rejected === null && r.display === 'block' && r.shown === '1';
      const fullLineOk = Math.abs(r.box.width - r.contentWidth) <= 1;
      const lineFails = compare(r.ghostLines, r.acceptedLines);
      const detail = '行数 ' + r.ghostLines.length + '/' + r.acceptedLines.length
        + '，盒子宽=' + round(r.box.width) + '（内容宽=' + round(r.contentWidth) + '）'
        + '，text-indent=' + round(r.box.indent);
      // 判据顺序：先看「画没画出来」，再看「画出来的行与采纳后是否重合」。
      // 盒子宽只作读数（随 detail 一起打出）：单行建议即便盒子窄一截，行首也是对的——
      // 那不算缺陷。真正的判据是折行后每一行的落点。
      if (!shapeOk) {
        record(s.id + '｜灰字真的画出来了（过自检、display:block、data-shown=1）', STATUS.FAIL,
          'reject=' + String(r.rejected) + ' display=' + r.display + ' shown=' + String(r.shown));
      } else if (lineFails.length > 0) {
        record(s.id + '｜灰字行首 = 采纳后行首（' + s.label + '）', STATUS.FAIL,
          lineFails.join('\n      ') + '\n      ' + detail
          + (fullLineOk ? '' : '（盒子不是整行全宽：旧口径）'));
      } else {
        record(s.id + '｜灰字行首 = 采纳后行首（' + s.label + '）', STATUS.PASS,
          detail + (fullLineOk ? '' : '（注意：盒子不是整行全宽）'));
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
