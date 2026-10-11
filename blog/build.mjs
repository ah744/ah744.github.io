// Build the blog: blog/posts/<slug>/post.tex  →  blog/<slug>/index.html, plus blog/index.html.
//
//   node blog/build.mjs            build every dated post
//   node blog/build.mjs --drafts   also build undated posts (local preview only)
//   node blog/build.mjs --watch    rebuild whenever a post changes
//
// Rendering reuses folio's own scanner and KaTeX layer, so a post reads on the web exactly as it
// does in the editor. FOLIO points at the folio checkout (default ~/Research/folio).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FOLIO = process.env.FOLIO || path.join(os.homedir(), 'Research/folio');
const web = f => import(pathToFileURL(path.join(FOLIO, 'web', f)).href);
const { analyze, SECTIONS, FORMAT, CITES, REFS, FLOATS, LISTS } = await web('scan.js');
const { katexHTML, displayTeX, texToHTML, tabularHTML, setMacros } = await web('render.js');
const { citeLabel } = await web('citelabel.js');

const BLOG = path.dirname(fileURLToPath(import.meta.url));
const POSTS = path.join(BLOG, 'posts');
const args = new Set(process.argv.slice(2));
const AUTHOR = 'Adam Holmes';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const UPRIGHT = new Set(['Definition', 'Remark', 'Example', 'Proof', 'Observation']);
const REF_NAMES = { equation: 'Eq.', section: 'Sec.', figure: 'Fig.', 'figure*': 'Fig.', table: 'Table', 'table*': 'Table' };
const TEXT_CMDS = { LaTeX: 'L<span class="la">a</span>T<span class="tex-e">e</span>X', TeX: 'T<span class="tex-e">e</span>X',
  ldots: '…', dots: '…', textendash: '–', textemdash: '—', quad: ' ', qquad: '  ', S: '§', P: '¶' };

// ── bibliography ─────────────────────────────────────────────────────────────

function parseBib(text) {
  const out = new Map();
  for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,/g)) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < text.length && depth; i++) depth += text[i] === '{' ? 1 : text[i] === '}' ? -1 : 0;
    const body = text.slice(m.index + m[0].length, i - 1), f = {};
    for (const g of body.matchAll(/(\w+)\s*=\s*(?:\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}|"([^"]*)"|([^,\n]+))/g))
      f[g[1].toLowerCase()] = (g[2] ?? g[3] ?? g[4]).trim();
    out.set(m[2], { key: m[2], author: f.author || '', title: f.title || '', year: f.year || '',
      venue: f.journal || f.booktitle || f.eprint || '', url: f.doi ? `https://doi.org/${f.doi}` : f.url || '' });
  }
  return out;
}

// ── one post ─────────────────────────────────────────────────────────────────

function renderPost(src, dir, outDir) {
  const m = analyze(src);
  setMacros(m.macros);
  const bibFiles = [...src.matchAll(/\\(?:bibliography|addbibresource)\{([^}]+)\}/g)]
    .flatMap(x => x[1].split(',')).map(n => path.join(dir, n.trim().replace(/(\.bib)?$/, '.bib')));
  const bib = new Map(bibFiles.filter(fs.existsSync).flatMap(f => [...parseBib(fs.readFileSync(f, 'utf8'))]));
  const notes = [], slice = ([a, b]) => src.slice(a, b);
  const anchor = k => 'l-' + k.replace(/[^\w-]/g, '-');
  const claimed = new Set(); // labels whose anchor already sits on a heading / theorem / figure
  const idAttr = key => { if (!key) return ''; claimed.add(key); return ` id="${anchor(key)}"`; };
  const ctx = {
    cite: keys => esc(citeLabel('cite', keys.split(',').map(k => k.trim()), m.cites, bib)),
    ref: (k, eq) => { const n = m.labels[k]?.num ?? '??'; return eq ? `(${n})` : n; },
  };
  const lo = m.docBegin > 0 ? m.docBegin : 0, hi = m.docEnd > 0 ? m.docEnd : src.length;

  // the items directly inside [a, b): skip anything nested in an item already taken
  const topLevel = (a, b) => {
    const out = [];
    let end = a;
    for (const it of m.items) if (it.from >= end && it.to <= b && it.from >= a) { out.push(it); end = it.to; }
    return out;
  };

  const isBlock = it => (it.type === 'math' && it.display) || it.type === 'verbatim' || it.type === 'env'
    || (it.type === 'cmd' && (it.name in SECTIONS && SECTIONS[it.name] < 4 || ['maketitle', 'bibliography', 'printbibliography'].includes(it.name)));

  // prose between items; folio's scanner leaves symbol commands (\\ \% \,) in the text
  const text = s => esc(s.replace(/\s+/g, ' '))
    .replace(/\\\\(\[[^\]]*\])?/g, '<br>').replace(/\\([%$&#_{}])/g, '\u0001$1').replace(/\\,/g, ' ')
    .replace(/\\[ ;:!/@]/g, c => (c[1] === ' ' ? ' ' : '')).replace(/(?<!\u0001)[{}]/g, '').replace(/\u0001/g, '');

  /** Inline content of [a, b) — never produces paragraphs. */
  function inline(a, b) {
    let out = '', p = a;
    for (const it of topLevel(a, b)) {
      out += text(src.slice(p, it.from)) + inlineItem(it);
      p = it.to;
      if (it.type === 'comment') { while (/[ \t\n]/.test(src[p] || '') && p < b) p++; } // % eats the newline
    }
    return out + text(src.slice(p, b));
  }

  function inlineItem(it) {
    if (it.type === 'comment' || it.type === 'def') return '';
    if (it.type === 'glyph') return it.text === ' ' ? '&nbsp;' : it.text;
    if (it.type === 'math') return safeMath(slice(it.inner), false);
    if (it.type !== 'cmd') return esc(slice(it));
    const name = it.name, a0 = it.args?.[0];
    if (!it.known) return TEXT_CMDS[name] ?? ''; // unknown commands stay quiet on the web
    if (name in FORMAT) {
      const t = FORMAT[name], body = inline(a0[0], a0[1]);
      return t === 'b' ? `<b>${body}</b>` : t === 'i' ? `<em>${body}</em>` : t === 'tt' ? `<code>${body}</code>`
        : t === 'sc' ? `<span class="sc">${body}</span>` : t === 'u' ? `<u>${body}</u>` : t === 'sf' ? `<span class="sf">${body}</span>` : body;
    }
    if (name in SECTIONS) return `<b class="runin">${inline(a0[0], a0[1])}</b> `; // \paragraph
    const keys = a0 ? slice(a0).split(',').map(k => k.trim()).filter(Boolean) : [];
    if (CITES.has(name)) {
      const label = esc(citeLabel(name, keys, m.cites, bib));
      return `<a class="cite" href="#ref-${m.cites[keys[0]] ?? ''}">${label}</a>`;
    }
    if (REFS.has(name)) {
      const hits = keys.map(k => m.labels[k]), nums = hits.map(h => h?.num ?? '??').join(', ');
      const word = /ref$/.test(name) && !['eqref', 'ref', 'pageref'].includes(name) ? (REF_NAMES[hits[0]?.kind] ?? '') + ' ' : '';
      return `<a class="ref" href="#${anchor(keys[0] || '')}">${esc(name === 'eqref' ? `(${nums})` : word + nums)}</a>`;
    }
    if (name === 'label') return claimed.has(slice(a0).trim()) ? '' : `<span${idAttr(slice(a0).trim())}></span>`;
    if (name === 'footnote') {
      notes.push(inline(a0[0], a0[1]));
      const n = notes.length;
      return `<sup class="fn"><a id="fnref-${n}" href="#fn-${n}">${n}</a></sup>`;
    }
    if (name === 'url') return `<a href="${esc(slice(a0))}">${esc(slice(a0))}</a>`;
    if (name === 'href') return `<a href="${esc(slice(a0))}">${inline(it.args[1][0], it.args[1][1])}</a>`;
    if (name === 'includegraphics') return image(slice(a0));
    if (name === 'item') return ''; // handled by list()
    return '';
  }

  function safeMath(tex, display) {
    try { return katexHTML(tex, display); }
    catch (e) { console.warn(`  math: ${e.message.split('\n')[0]}`); return `<code class="bad">${esc(tex)}</code>`; }
  }

  /** Copy a figure next to the page (PDF figures are rasterised with sips, as folio does). */
  function image(p) {
    p = p.trim();
    const hit = ['', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'].map(e => path.join(dir, p + e)).find(f => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!hit) { console.warn(`  missing figure: ${p}`); return `<span class="bad">${esc(p)}</span>`; }
    let name = path.basename(hit);
    if (hit.endsWith('.pdf')) {
      name = name.replace(/\.pdf$/, '.png');
      execFileSync('sips', ['-s', 'format', 'png', '-s', 'dpiWidth', '200', '-s', 'dpiHeight', '200', hit, '--out', path.join(outDir, name)], { stdio: 'ignore' });
    } else fs.copyFileSync(hit, path.join(outDir, name));
    return `<img src="${esc(name)}" alt="" loading="lazy">`;
  }

  /** Block flow of [a, b): paragraphs split at blank lines, block items in between. */
  function flow(a, b) {
    let out = '', para = '', p = a;
    const flush = () => { if (para.trim()) out += `<p>${para.trim()}</p>\n`; para = ''; };
    const gap = s => {
      const parts = s.split(/\n[ \t]*\n/);
      parts.forEach((t, i) => { if (i) flush(); para += text(t); });
    };
    for (const it of topLevel(a, b)) {
      gap(src.slice(p, it.from));
      p = it.to;
      if (it.type === 'comment') { while (/[ \t]/.test(src[p] || '')) p++; if (src[p] === '\n' && !/^\n[ \t]*\n/.test(src.slice(p, p + 40))) p++; continue; }
      if (!isBlock(it)) { para += inlineItem(it); continue; }
      flush();
      out += block(it);
      if (it.type === 'math') out += '\n'; // text after display math continues the paragraph, unindented
    }
    gap(src.slice(p, b));
    flush();
    return out;
  }

  function block(it) {
    if (it.type === 'math') {
      const id = [...slice(it.inner).matchAll(/\\label\{([^}]*)\}/g)].map(x => ` id="${anchor(x[1])}"`)[0] || '';
      return `<div class="display"${id}>${safeMath(displayTeX(it.env, slice(it.inner), m.eqs.get(it.from)), true)}</div>\n`;
    }
    if (it.type === 'verbatim') {
      const body = src.slice(src.indexOf('}', it.from) + 1, src.lastIndexOf('\\end', it.to)).replace(/^\n|\n\s*$/g, '');
      return it.env === 'comment' ? '' : `<pre><code>${esc(body)}</code></pre>\n`;
    }
    if (it.type === 'env') return env(it);
    const name = it.name;
    if (name === 'maketitle') return ''; // the page header carries the title
    if (name === 'bibliography' || name === 'printbibliography') return references();
    const lvl = SECTIONS[name], num = m.sections.get(it.from), a0 = it.args[0];
    const label = src.slice(it.to, it.to + 200).match(/^\s*\\label\{([^}]*)\}/);
    return `<h${lvl + 1}${idAttr(label?.[1].trim())}>${num ? `<span class="secnum">${num}</span>` : ''}${inline(a0[0], a0[1])}</h${lvl + 1}>\n`;
  }

  function env(it) {
    const name = it.env, num = m.envNum.get(it.from), inner = [it.beginTo, it.endFrom];
    if (FLOATS.has(name)) {
      const all = m.items.filter(k => k.from > it.from && k.to < it.to);
      const kind = name.startsWith('figure') ? 'Figure' : 'Table';
      const cap = all.find(k => k.name === 'caption'), tab = all.find(k => k.env === 'tabular');
      const lab = all.find(k => k.name === 'label');
      const imgs = all.filter(k => k.name === 'includegraphics').map(k => image(slice(k.args[0]))).join('');
      const capHTML = cap ? `<figcaption><b>${kind} ${num}:</b> ${inline(cap.args[0][0], cap.args[0][1])}</figcaption>` : '';
      const body = imgs + (tab ? tabularHTML(src.slice(tab.beginTo, tab.endFrom), ctx) : '');
      return `<figure class="${kind.toLowerCase()}"${idAttr(lab && slice(lab.args[0]).trim())}>${kind === 'Table' ? capHTML + body : body + capHTML}</figure>\n`;
    }
    if (LISTS.has(name)) {
      const items = topLevel(...inner).filter(k => k.name === 'item');
      const lis = items.map((k, i) => {
        const end = items[i + 1]?.from ?? it.endFrom;
        const body = flow(k.to, end).replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1'); // single paragraph → bare
        return name === 'description' ? `<dt>${k.opts[0] ? inline(...k.opts[0]) : ''}</dt><dd>${body}</dd>` : `<li>${body}</li>`;
      }).join('\n');
      const tag = name === 'itemize' ? 'ul' : name === 'enumerate' ? 'ol' : 'dl';
      return `<${tag}>\n${lis}\n</${tag}>\n`;
    }
    const th = m.theorems[name];
    if (name === 'abstract') return `<div class="abstract">${flow(...inner)}</div>\n`;
    if (th) {
      const opt = it.opt ? ` (${inline(...it.opt)})` : '';
      const head = name === 'proof' ? `<i>Proof${opt}.</i> ` : `<span class="thm-head"><b>${th.title}${num ? ' ' + num : ''}</b>${opt}.</span> `;
      const lab = m.items.find(k => k.name === 'label' && k.from > it.from && k.to < it.to);
      const id = idAttr(lab && slice(lab.args[0]).trim()); // before flow(), which meets the \label
      let body = flow(...inner);
      body = body.startsWith('<p>') ? '<p>' + head + body.slice(3) : `<p>${head}</p>` + body;
      if (name === 'proof') body = body.replace(/<\/p>\n?$/, '<span class="qed">∎</span></p>\n');
      const cls = name === 'proof' ? 'proof' : UPRIGHT.has(th.title) ? 'thm upright' : 'thm';
      return `<div class="${cls}"${id}>${body}</div>\n`;
    }
    if (name === 'center') return `<div class="center">${flow(...inner)}</div>\n`;
    if (name === 'quote' || name === 'quotation') return `<blockquote>${flow(...inner)}</blockquote>\n`;
    if (name === 'tabular') return `<figure class="table">${tabularHTML(src.slice(...inner), ctx)}</figure>\n`;
    return flow(...inner); // unknown environments: just their contents
  }

  function references() {
    const keys = Object.keys(m.cites);
    if (!keys.length) return '';
    const li = keys.map(k => {
      const e = bib.get(k);
      if (!e) { console.warn(`  cite key not in .bib: ${k}`); return `<li id="ref-${m.cites[k]}"><span class="bibnum">[${m.cites[k]}]</span> <span class="bad">${esc(k)}</span></li>`; }
      const title = texToHTML(e.title);
      return `<li id="ref-${m.cites[k]}"><span class="bibnum">[${m.cites[k]}]</span> ${texToHTML(e.author.replace(/\s+and\s+/g, ', '))}, `
        + `<i>${e.url ? `<a href="${esc(e.url)}">${title}</a>` : title}</i>${e.venue ? ', ' + texToHTML(e.venue) : ''}${e.year ? ` (${esc(e.year)})` : ''}.</li>`;
    });
    return `<section class="refs"><h2>References</h2><ol>\n${li.join('\n')}\n</ol></section>\n`;
  }

  let body = flow(lo, hi);
  if (notes.length) {
    const fn = notes.map((n, i) => `<li id="fn-${i + 1}">${n} <a class="back" href="#fnref-${i + 1}">↩</a></li>`).join('\n');
    // notes sit above the references, like a paper's endnotes
    const at = body.indexOf('<section class="refs">');
    const html = `<section class="notes"><h2>Notes</h2><ol>\n${fn}\n</ol></section>\n`;
    body = at < 0 ? body + html : body.slice(0, at) + html + body.slice(at);
  }
  const plainTitle = s => texToHTML(s || '').replace(/<[^>]+>/g, '');
  const abstract = m.meta.abstract ? flow(m.meta.abstract.beginTo, m.meta.abstract.endFrom) : '';
  return { meta: m.meta, body, title: plainTitle(m.meta.title) || 'Untitled', titleHTML: texToHTML(m.meta.title || 'Untitled', ctx),
    summary: ((abstract || body).match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? '').replace(/<a [^>]*>|<\/a>|<sup class="fn">.*?<\/sup>/g, '') };
}

// ── publishing policy ────────────────────────────────────────────────────────

/**
 * When does a post go live, and under what date? `rawDate` is the post's \date{...} source
 * (e.g. "October 11, 2026", "2026-10-11", "\today", or ""). Return a Date to publish, or null
 * to keep it a draft. Draft posts are only built with --drafts.
 */
function publishDate(rawDate) {
  // TODO(you): the publishing rule. Default: an explicit, parseable date publishes; \today or
  // an empty \date{} (folio's template) keeps the post a draft. Future-dated posts? Your call.
  const d = new Date(rawDate.trim());
  return rawDate.includes('\\') || isNaN(d) ? null : d;
}

// ── pages ────────────────────────────────────────────────────────────────────

const fmtDate = d => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

const page = ({ title, root, body, description = '' }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">\n` : ''}<link rel="stylesheet" href="${root}katex/katex.min.css">
<link rel="stylesheet" href="${root}blog.css">
<link rel="shortcut icon" type="image/x-icon" href="/favicon-font.ico">
</head>
<body>
<nav class="top"><a href="/">Adam Holmes</a><a href="${root}">Blog</a></nav>
${body}
</body>
</html>
`;

function build() {
  const posts = [];
  for (const slug of fs.readdirSync(POSTS).sort()) {
    const file = path.join(POSTS, slug, 'post.tex');
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const date = publishDate(analyze(src).meta.date ?? '');
    const outDir = path.join(BLOG, slug);
    if (!date && !args.has('--drafts')) { console.log(`draft  ${slug}`); fs.rmSync(outDir, { recursive: true, force: true }); continue; }
    fs.mkdirSync(outDir, { recursive: true });
    const p = renderPost(src, path.dirname(file), outDir);
    const when = date ? fmtDate(date) : 'Draft';
    fs.writeFileSync(path.join(outDir, 'index.html'), page({
      title: `${p.title} — Adam Holmes`, root: '../', description: p.summary.replace(/<[^>]+>/g, '').slice(0, 200),
      body: `<article>
<header><h1>${p.titleHTML}</h1><div class="byline">${p.meta.authors.filter(a => a.trim()).map(a => texToHTML(a)).join(', ') || AUTHOR} &middot; <time${date ? ` datetime="${date.toISOString().slice(0, 10)}"` : ''}>${when}</time></div></header>
${p.body}</article>`,
    }));
    posts.push({ slug, date, when, ...p });
    console.log(`built  ${slug}${date ? '' : ' (draft)'}`);
  }
  posts.sort((a, b) => (b.date ?? Infinity) - (a.date ?? Infinity));
  const list = posts.map(p => `<li><a href="${p.slug}/"><span class="t">${p.titleHTML}</span><time>${p.when}</time></a>${p.summary ? `<p>${p.summary}</p>` : ''}</li>`).join('\n');
  fs.writeFileSync(path.join(BLOG, 'index.html'), page({
    title: 'Blog — Adam Holmes', root: '',
    body: `<article class="index">\n<header><h1>Blog</h1></header>\n<ol class="posts">\n${list || '<li class="empty">Nothing here yet.</li>'}\n</ol>\n</article>`,
  }));
  // KaTeX's stylesheet and fonts, from the same version folio renders with
  const kx = path.join(FOLIO, 'node_modules/katex/dist');
  fs.cpSync(path.join(kx, 'katex.min.css'), path.join(BLOG, 'katex/katex.min.css'));
  fs.cpSync(path.join(kx, 'fonts'), path.join(BLOG, 'katex/fonts'), { recursive: true, filter: f => !/\.(ttf|woff)$/.test(f) });
}

build();
if (args.has('--watch')) {
  let t;
  console.log('watching blog/posts …');
  fs.watch(POSTS, { recursive: true }, () => { clearTimeout(t); t = setTimeout(() => { try { build(); } catch (e) { console.error(e); } }, 150); });
}
