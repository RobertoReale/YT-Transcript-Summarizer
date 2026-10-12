// The side panel assigns parseMarkdown() output to innerHTML, so two things
// matter: model text can never become live HTML, and what models really write
// (lists, tables, snake_case, links, [m:ss] anchors) renders as intended.
import { parseMarkdown, timestampSeconds } from '../modules/markdown.js';
import { check, finish } from './harness.mjs';

const md = (s) => parseMarkdown(s);
const has = (html, frag) => html.includes(frag);

// ── safety ──
check('script tags are escaped', has(md('<script>alert(1)</script>'), '<script>'), false);
check('...and shown as text', has(md('<script>alert(1)</script>'), '&lt;script&gt;'), true);
check('javascript: links are not emitted', has(md('[x](javascript:alert(1))'), '<a'), false);
check('attribute injection via link url is escaped',
  has(md('[x](https://a.b/"onmouseover="alert(1))'), '"onmouseover'), false);
check('html inside code stays text', has(md('`<b>x</b>`'), '<code>&lt;b&gt;x&lt;/b&gt;</code>'), true);

// ── inline ──
check('bold', md('a **b** c'), '<p>a <strong>b</strong> c</p>');
check('italic with *', md('a *b* c'), '<p>a <em>b</em> c</p>');
check('snake_case is left alone', md('use my_var_name here'), '<p>use my_var_name here</p>');
check('_italic_ at word boundaries', md('an _emph_ word'), '<p>an <em>emph</em> word</p>');
check('markdown link', has(md('see [docs](https://example.com/a_b_c)'), '<a href="https://example.com/a_b_c" target="_blank" rel="noopener noreferrer">docs</a>'), true);
check('bare url', has(md('go to https://example.com/x_y.'), 'href="https://example.com/x_y"'), true);
check('bare url drops trailing period', has(md('go to https://example.com/x_y.'), '</a>.'), true);

// ── timestamps ──
check('m:ss → seconds', timestampSeconds('1:30'), 90);
check('h:mm:ss → seconds', timestampSeconds('1:02:03'), 3723);
check('not a timestamp', timestampSeconds('note'), null);
check('[m:ss] becomes a seek link', has(md('point [1:30] here'), 'data-time="90">[1:30]</a>'), true);
check('[h:mm:ss] too', has(md('x [1:02:03]'), 'data-time="3723"'), true);
check('an already-linked timestamp seeks instead of navigating',
  has(md('[2:00](https://www.youtube.com/watch?v=abc&t=120s)'), 'data-time="120"'), true);
check('...and keeps no external href', has(md('[2:00](https://www.youtube.com/watch?v=abc&t=120s)'), 'youtube.com'), false);
check('a bracketed word is not a link', md('a [note] b'), '<p>a [note] b</p>');

// ── blocks ──
check('headings', md('# A\n## B\n### C'), '<h1>A</h1>\n<h2>B</h2>\n<h3>C</h3>');
check('paragraph lines keep their breaks', md('one\ntwo'), '<p>one<br>two</p>');
check('two paragraphs', md('one\n\ntwo'), '<p>one</p>\n<p>two</p>');
check('bullet list', md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
check('numbered list', md('1. a\n2. b'), '<ol><li>a</li><li>b</li></ol>');
check('numbered list keeps its start', has(md('3. c\n4. d'), '<ol start="3">'), true);
check('nested list', md('- a\n  - a1\n  - a2\n- b'),
  '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>');
check('list with blank lines between items stays one list', md('- a\n\n- b'), '<ul><li>a</li><li>b</li></ul>');
check('blockquote', md('> quoted **x**'), '<blockquote><p>quoted <strong>x</strong></p></blockquote>');
check('fenced code is not formatted', md('```\n**x** <y>\n```'), '<pre><code>**x** &lt;y&gt;</code></pre>');
check('unterminated fence (mid-stream) still renders', has(md('```js\nlet a'), '<pre><code>let a</code></pre>'), true);
check('horizontal rule', md('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>');
const table = md('| Topic | Time |\n|---|---|\n| Intro | [0:30] |\n| End | 9:00 |');
check('table header', has(table, '<thead><tr><th>Topic</th><th>Time</th></tr></thead>'), true);
check('table cell with timestamp link', has(table, '<td><a href="#" class="timestamp-link" data-time="30">[0:30]</a></td>'), true);
check('table row count', (table.match(/<tr>/g) || []).length, 3);
check('empty input', md(''), '');

finish();
