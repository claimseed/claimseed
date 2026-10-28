#!/usr/bin/env python3
"""Regenerate fonts/coverage.json: the union of code points the bundled @fontsource faces can draw, plus the
sha256 of each face file, so test/font-coverage.test.js can prove every character in templates, stock content,
scenarios and the lexicon has a glyph (a missing one would render as a box from the font's own .notdef, which
pdffonts cannot see). Run after changing fonts: python3 scripts/font-coverage.py (needs fontTools, brotli)."""
import os, sys, json, hashlib, glob
from fontTools.ttLib import TTFont
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..')
def find_fontsource():
    d = root
    for _ in range(6):
        c = os.path.join(d, 'node_modules', '@fontsource')
        if os.path.isdir(c): return c
        d = os.path.dirname(d)
    sys.exit('no node_modules/@fontsource found')
FS = find_fontsource()
FACES = [('inter', 400), ('inter', 600), ('inter', 700), ('noto-sans', 400), ('noto-sans', 700), ('noto-serif', 400), ('noto-serif', 700),
         ('courier-prime', 400), ('courier-prime', 700), ('noto-sans', 400, 'vietnamese'), ('noto-sans', 700, 'vietnamese'),
         ('noto-sans-sc', 400, 'chinese-simplified'), ('noto-sans-kr', 400, 'korean')]
cover = {}; files = {}
for pkg, weight, *subset in FACES:
    subset = subset[0] if subset else 'latin'
    f = os.path.join(FS, pkg, 'files', f'{pkg}-{subset}-{weight}-normal.woff2')
    if not os.path.exists(f): continue
    t = TTFont(f)
    cps = set(t.getBestCmap().keys())
    fam = {'inter': 'Inter', 'noto-sans': 'Noto Sans', 'noto-serif': 'Noto Serif', 'courier-prime': 'Courier Prime', 'noto-sans-sc': 'Noto Sans SC', 'noto-sans-kr': 'Noto Sans KR'}[pkg]
    cover.setdefault(fam, set()).update(cps)
    files[os.path.relpath(f, FS)] = hashlib.sha256(open(f, 'rb').read()).hexdigest()
def ranges(cps):
    out = []; s = None; prev = None
    for c in sorted(cps):
        if s is None: s = prev = c
        elif c == prev + 1: prev = c
        else: out.append([s, prev]); s = prev = c
    if s is not None: out.append([s, prev])
    return out
json.dump({'generatedBy': 'scripts/font-coverage.py', 'files': files, 'families': {k: ranges(v) for k, v in cover.items()}},
          open(os.path.join(root, 'fonts', 'coverage.json'), 'w'), indent=0)
print({k: len(v) for k, v in cover.items()})
