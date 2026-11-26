/**
 * 幽灵「滚动不重排」探针的页内脚本（由 scripts/ghost-scroll-probe.mjs 注入）。
 *
 * 只搭宿主 composer 的三层 DOM + 一个会滚动的输入区，用真实 GhostOverlay 画一段多行灰字，
 * 然后把「灰字是否跟着正文一起滚」与「滚动有没有触发重排」两个量交回驱动脚本。
 */
(() => {
  const mk = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; };
  window.__scrollSetup = (lines, suffix) => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    const style = mk('style');
    style.textContent = [
      'body{margin:0;padding:16px;background:#fff;font-family:-apple-system,"PingFang SC",sans-serif}',
      '.card{width:900px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:8px 0 10px}',
      '[data-input-scroll]{max-height:120px;margin-right:4px;overflow-y:auto}',
      '.grow{position:relative}',
      '[data-composer-input]{box-sizing:border-box;min-height:52px;font:inherit;font-size:14px;line-height:24px;',
      'white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;outline:none;padding:4px 8px 0 14px;color:#111}',
      '[data-composer-input] p{margin:0}',
    ].join('\n');
    document.head.appendChild(style);
    const card = mk('div', 'card');
    const scroll = mk('div'); scroll.setAttribute('data-input-scroll', '');
    const grow = mk('div', 'grow');
    const input = mk('div'); input.setAttribute('data-composer-input', ''); input.setAttribute('contenteditable', 'true');
    for (const line of lines) input.appendChild(mk('p', '', line));
    grow.appendChild(input); scroll.appendChild(grow); card.appendChild(scroll);
    document.body.appendChild(card);
    const draft = lines.join('\n');
    const overlay = new globalThis.__GhostOverlay();
    overlay.attach(input);
    overlay.show({ kind: 'history', prefix: draft, suffix, full: draft + suffix, frame: { frame: 0, final: true } });
    window.__probe = { scroll, input, overlay, el: overlay.el };
    return { sh: scroll.scrollHeight, ch: scroll.clientHeight, display: getComputedStyle(overlay.el).display };
  };

  window.__scrollSample = () => {
    const { scroll, input, el } = window.__probe;
    const blocks = Array.from(input.children);
    const last = blocks[blocks.length - 1];
    let a = null;
    if (last) {
      const r = document.createRange(); r.selectNodeContents(last);
      const rs = Array.from(r.getClientRects()).filter(x => x.height > 0);
      const rect = rs[rs.length - 1];
      if (rect) a = { top: rect.top, right: rect.right };
    }
    let g = null, lines = 0;
    if (el.firstElementChild) {
      const rr = document.createRange(); rr.selectNodeContents(el.firstElementChild);
      const rs = Array.from(rr.getClientRects()).filter(x => x.height > 0);
      if (rs.length) g = rs[0];
      lines = rs.length;
    }
    return {
      st: Math.round(scroll.scrollTop * 100) / 100,
      display: getComputedStyle(el).display,
      reject: el.dataset.reject || null,
      styleTop: el.style.top,
      dy: (a && g) ? Math.round((g.top - a.top) * 100) / 100 : null,
      dx: (a && g) ? Math.round((g.left - a.right) * 100) / 100 : null,
      lines,
    };
  };

  window.__scrollTo = (st) => { window.__probe.scroll.scrollTop = st; };
  window.__setSentinel = (value) => { window.__probe.el.style.top = value; };
  return true;
})();
