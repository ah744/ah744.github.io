# Blog

Posts are plain LaTeX, written in folio (`~/Research/folio`) and published as static HTML that
reads like folio's page.

```
blog/posts/<slug>/post.tex     ← you write this (plus refs.bib and any figures beside it)
blog/<slug>/index.html         ← generated
blog/index.html                ← generated list, newest first
```

## Write

```bash
folio blog/posts/my-post/post.tex        # a missing file starts from folio's template
```

A post is a **draft** until its `\date{}` is an explicit date (`\date{October 11, 2026}`);
folio's template uses `\date{\today}`, so new posts start as drafts.

## Publish

```bash
node blog/build.mjs              # build every dated post (drafts are removed from the output)
node blog/build.mjs --drafts     # also build drafts, for a local look
node blog/build.mjs --watch      # rebuild on every save
python3 -m http.server 4000      # then open http://localhost:4000/blog/
```

Commit `blog/` and push. GitHub Pages serves the generated HTML as-is.

The build imports folio's own scanner and KaTeX layer (`$FOLIO/web`, default `~/Research/folio`),
so numbering, macros, theorems, `\cite`/`\ref`, footnotes and figures match what you saw while
writing. Math is pre-rendered, so pages need no JavaScript. PDF figures are rasterised with `sips`.
