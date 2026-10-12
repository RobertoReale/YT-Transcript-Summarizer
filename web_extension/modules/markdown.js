// ── markdown.js — a small, dependency-free Markdown renderer for summaries ────
// Remote scripts are off-limits in MV3 pages, so no marked.js. This covers what
// models actually write in a summary: headings, paragraphs, nested bullet and
// numbered lists, blockquotes, fenced code, tables, rules, and the inline set
// (bold, italic, strike, code, links). `[m:ss]` anchors become seek links.
//
// Safety model: every piece of text is HTML-escaped before any tag is added,
// and links are only emitted for http(s) URLs. The output is then safe to
// assign to innerHTML even though the input is model-generated.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

const TS_RE = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/;

/** `m:ss` / `h:mm:ss` → seconds, or null when the text is not a timestamp. */
export function timestampSeconds(text) {
  const m = TS_RE.exec(String(text).trim());
  if (!m) return null;
  return m[3] !== undefined ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
}

function tsLink(label, seconds) {
  return `<a href="#" class="timestamp-link" data-time="${seconds}">[${escapeHtml(label)}]</a>`;
}

// ── Inline ───────────────────────────────────────────────────────────────────
// Code spans and links are cut out first and replaced by placeholders, so the
// emphasis rules cannot reach inside them (a `*` in code, an `_` in a URL).
function inline(src) {
  const slots = [];
  const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(src);

  s = s.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`));

  // [label](url) — a timestamp label always seeks in the open video, even when
  // the model (or linkTimestamps in API mode) attached a youtube.com URL.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label, url) => {
    const t = timestampSeconds(label);
    if (t !== null) return hold(tsLink(label, t));
    if (!/^https?:\/\//i.test(url)) return whole;
    return hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${inlineEmphasis(escapeHtml(label))}</a>`);
  });

  // Bare [m:ss] anchors copied from the transcript.
  s = s.replace(/\[(\d{1,2}:[0-5]\d(?::[0-5]\d)?)\]/g, (whole, label) => {
    const t = timestampSeconds(label);
    return t === null ? whole : hold(tsLink(label, t));
  });

  // Bare URLs.
  s = s.replace(/\bhttps?:\/\/[^\s<>()\u0000]+[^\s<>()\u0000.,;:!?'"]/g,
    (url) => hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`));

  s = inlineEmphasis(escapeHtml(s));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
}

function inlineEmphasis(s) {
  return s
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)(.*?\S)__(?![\w])/g, '$1<strong>$2</strong>')
    .replace(/~~(?=\S)(.*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?![*\w])/g, '$1<em>$2</em>')
    // `_` only at word boundaries, so snake_case and file_names survive.
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?![\w])/g, '$1<em>$2</em>');
}

// ── Blocks ───────────────────────────────────────────────────────────────────
const RE = {
  fence:   /^\s{0,3}(```|~~~)\s*([\w+-]*)\s*$/,
  heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr:      /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
  quote:   /^\s{0,3}>\s?(.*)$/,
  item:    /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
};

const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function parseMarkdown(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) { flushPara(); continue; }

    const fence = RE.fence.exec(line);
    if (fence) {
      flushPara();
      const body = [];
      // An unterminated fence (still streaming) runs to the end — fine.
      for (i++; i < lines.length && !new RegExp(`^\\s{0,3}${fence[1]}\\s*$`).test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const h = RE.heading.exec(line);
    if (h) {
      flushPara();
      const n = h[1].length;
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }

    if (RE.hr.test(line)) { flushPara(); out.push('<hr>'); continue; }

    if (RE.quote.test(line)) {
      flushPara();
      const body = [];
      while (i < lines.length && RE.quote.test(lines[i])) body.push(RE.quote.exec(lines[i++])[1]);
      i--;
      out.push(`<blockquote>${parseMarkdown(body.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1])) {
      flushPara();
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      i--;
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>');
      continue;
    }

    if (RE.item.test(line)) {
      flushPara();
      const block = [];
      while (i < lines.length) {
        const l = lines[i];
        if (RE.item.test(l)) { block.push(l); i++; continue; }
        // A blank line inside a list only continues it if another item follows.
        if (!l.trim() && i + 1 < lines.length && RE.item.test(lines[i + 1])) { i++; continue; }
        // An indented continuation line belongs to the previous item.
        if (l.trim() && /^\s{2,}/.test(l) && block.length) { block[block.length - 1] += ' ' + l.trim(); i++; continue; }
        break;
      }
      i--;
      out.push(renderList(block));
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  return out.join('\n');
}

// Nested lists from indentation: a deeper indent opens a sub-list inside the
// current item, a shallower one closes back to the matching level.
function renderList(lines) {
  let html = '';
  const stack = []; // { indent, tag }
  for (const l of lines) {
    const [, ws, marker, body] = RE.item.exec(l);
    const indent = ws.replace(/\t/g, '    ').length;
    const tag = /\d/.test(marker) ? 'ol' : 'ul';

    while (stack.length && indent < stack[stack.length - 1].indent) {
      html += `</li></${stack.pop().tag}>`;
    }
    const top = stack[stack.length - 1];
    if (!top || indent > top.indent) {
      const start = tag === 'ol' && parseInt(marker, 10) !== 1 ? ` start="${parseInt(marker, 10)}"` : '';
      html += `<${tag}${start}>`;
      stack.push({ indent, tag });
    } else if (top.tag !== tag) {
      html += `</li></${stack.pop().tag}><${tag}>`;
      stack.push({ indent, tag });
    } else {
      html += '</li>';
    }
    html += `<li>${inline(body)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}
