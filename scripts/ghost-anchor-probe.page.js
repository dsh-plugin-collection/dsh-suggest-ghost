/**
 * 幽灵锚点探针的页内脚本（由 scripts/ghost-anchor-probe.mjs 注入）。
 *
 * 只做三件事：按「节点描述」搭出宿主 composer 的真实 DOM（引用 chip / quote 用宿主的
 * 真实结构与 CSS），用真实 GhostOverlay 画一段历史补全，然后把**构造时就知道的收尾节点**
 * 与灰字首行量回来交给驱动脚本对比。
 *
 * 之所以独立成文件：驱动脚本要把它整段 evaluate 进页面，写在字符串里会与驱动自己的
 * 模板字符串打架（本仓库踩过：反引号提前闭合）。
 */
(() => {
  const mk = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const CSS = [
    '.card{width:920px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:8px 0 0}',
    '[data-input-scroll]{max-height:336px;margin-right:4px;overflow-y:auto}',
    '.grow{position:relative}',
    '[data-composer-input]{box-sizing:border-box;min-height:52px;font:inherit;font-size:14px;line-height:24px;',
    'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;outline:none;padding:4px 8px 0 14px;color:#111}',
    '[data-composer-input] p{margin:0}',
    '.yAWgPa_chip{max-width:240px;color:#4d6bfe;user-select:none;align-items:baseline;gap:3px;display:inline-flex}',
    '.yAWgPa_marker{flex:none;font-weight:500}',
    '.yAWgPa_label{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
    '._quote{display:inline-flex;align-items:baseline;gap:4px;max-width:min(80%,300px);vertical-align:baseline;',
    'color:#4d6bfe;font-size:14px;line-height:20px}',
    '._source{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  ].join('\n');

  window.__anchorSetup = () => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    document.body.style.cssText = 'margin:0;padding:0;background:#fff';
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    return true;
  };

  const chip = (label, bare, minWidth) => {
    const outer = mk('span');
    outer.setAttribute('data-composer-chip', 'session');
    outer.setAttribute('contenteditable', 'false');
    const inner = mk('span', 'yAWgPa_chip');
    if (minWidth) inner.style.minWidth = minWidth;
    inner.appendChild(mk('span', 'yAWgPa_marker', '@'));
    if (!bare) inner.appendChild(mk('span', 'yAWgPa_label', label));
    outer.appendChild(inner);
    return outer;
  };

  const quote = (text) => {
    const outer = mk('span');
    outer.setAttribute('data-composer-quote', '');
    outer.setAttribute('contenteditable', 'false');
    const inner = mk('span', '_quote');
    inner.setAttribute('data-quote-preview', '');
    const src = mk('span', '_source');
    src.setAttribute('data-quote-preview-text', '');
    src.textContent = text;
    inner.append(mk('span', 'yAWgPa_marker', String.fromCharCode(8220)), src);
    outer.appendChild(inner);
    return outer;
  };

  window.__probeAnchor = (spec) => {
    const scroll = mk('div'); scroll.setAttribute('data-input-scroll', '');
    const grow = mk('div', 'grow');
    const input = mk('div'); input.setAttribute('data-composer-input', ''); input.setAttribute('contenteditable', 'true');
    const card = mk('div', 'card');

    let tail = null;
    for (const para of spec.paragraphs) {
      const p = mk('p');
      for (const node of para) {
        let child = null;
        if (node.kind === 'text') { child = document.createTextNode(node.text); }
        else if (node.kind === 'chip') { child = chip(node.label, node.bare, node.minWidth); }
        else if (node.kind === 'quote') { child = quote(node.text); }
        if (child === null) continue;
        p.appendChild(child);
        tail = child;
      }
      input.appendChild(p);
    }
    grow.appendChild(input); scroll.appendChild(grow); card.appendChild(scroll);
    document.body.appendChild(card);

    // 期望值从**构造时就知道的收尾节点**自己量：文本取末字符、内联原子取它自己的盒子。
    let expected = null;
    if (tail !== null && tail.nodeType === Node.TEXT_NODE) {
      const value = tail.nodeValue || '';
      const r = document.createRange();
      r.setStart(tail, Math.max(0, value.length - 1));
      r.setEnd(tail, value.length);
      const rect = r.getBoundingClientRect();
      expected = { right: Math.round(rect.right * 100) / 100, top: Math.round(rect.top * 100) / 100, via: 'text' };
    } else if (tail !== null) {
      const rect = tail.getBoundingClientRect();
      expected = { right: Math.round(rect.right * 100) / 100, top: Math.round(rect.top * 100) / 100, via: 'inline-box' };
    }

    const overlay = new globalThis.__GhostOverlay();
    overlay.attach(input);
    overlay.show({ kind: 'history', prefix: spec.draft, suffix: spec.suffix,
      full: spec.draft + spec.suffix, frame: { frame: 0, final: true } });

    const node = document.getElementById('dsh-suggest-ghost-overlay');
    if (node === null) return { fatal: 'overlay 节点不存在' };
    const span = node.firstElementChild;
    let firstLine = null;
    if (span !== null) {
      const r = document.createRange();
      r.selectNodeContents(span);
      const rects = Array.from(r.getClientRects()).filter(x => x.height > 0);
      if (rects.length > 0) firstLine = { left: Math.round(rects[0].left * 100) / 100, top: Math.round(rects[0].top * 100) / 100 };
    }
    const out = {
      reject: node.dataset.reject || null,
      display: getComputedStyle(node).display,
      box: { left: Math.round(parseFloat(node.style.left) * 100) / 100, indent: Math.round(parseFloat(node.style.textIndent) * 100) / 100 },
      expected,
      firstLine,
    };
    overlay.dispose();
    card.remove();
    return out;
  };


  /**
   * G：装饰器 portal **晚到**——先是一颗空盒子（chip 只可见 @），灰字已经画好；
   * 随后宿主把 label 提交进来（同一帧内 React 提交），观察者应当把灰字挪到新收尾之后。
   */
  window.__probeLatePortal = (spec) => new Promise((resolve) => {
    const scroll = mk('div'); scroll.setAttribute('data-input-scroll', '');
    const grow = mk('div', 'grow');
    const input = mk('div'); input.setAttribute('data-composer-input', ''); input.setAttribute('contenteditable', 'true');
    const card = mk('div', 'card');
    const p = mk('p');
    p.appendChild(document.createTextNode('第二步引用 '));
    const outer = mk('span');
    outer.setAttribute('data-composer-chip', 'session');
    outer.setAttribute('contenteditable', 'false');
    const inner = mk('span', 'yAWgPa_chip');
    inner.appendChild(mk('span', 'yAWgPa_marker', '@'));
    outer.appendChild(inner);
    p.appendChild(outer);
    input.appendChild(p);
    grow.appendChild(input); scroll.appendChild(grow); card.appendChild(scroll);
    document.body.appendChild(card);

    const overlay = new globalThis.__GhostOverlay();
    overlay.attach(input);
    overlay.show({ kind: 'history', prefix: spec.draft, suffix: spec.suffix,
      full: spec.draft + spec.suffix, frame: { frame: 0, final: true } });

    const measure = () => {
      const node = document.getElementById('dsh-suggest-ghost-overlay');
      const span = node === null ? null : node.firstElementChild;
      let firstLine = null;
      if (span !== null) {
        const r = document.createRange();
        r.selectNodeContents(span);
        const rects = Array.from(r.getClientRects()).filter(x => x.height > 0);
        if (rects.length > 0) firstLine = { left: Math.round(rects[0].left * 100) / 100 };
      }
      const box = outer.getBoundingClientRect();
      const out = {
        reject: node === null ? null : (node.dataset.reject || null),
        display: node === null ? null : getComputedStyle(node).display,
        expected: { right: Math.round(box.right * 100) / 100, via: 'inline-box' },
        firstLine,
      };
      overlay.dispose();
      card.remove();
      resolve(out);
    };

    // 先让第一帧画完（此时 chip 还是空盒子），再把 label 提交进来——模拟 portal 晚到。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const label = mk('span', 'yAWgPa_label', spec.label);
        inner.appendChild(label);
        // 观察者用 rAF 合并 ⇒ 等两拍再量。
        requestAnimationFrame(() => requestAnimationFrame(measure));
      });
    });
  });

  return true;
})();