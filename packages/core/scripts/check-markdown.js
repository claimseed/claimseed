#!/usr/bin/env node
// check-markdown.js — the structure of every Markdown file in the repository, so that a re-flowed line never breaks a
// table or a command block:
//  1. tables: every row has as many cells as the table's header row, and a non-blank line right after a row is a row
//  2. command blocks (```sh and ```bash fences, and four-space indented blocks that hold a command): every line is
//     blank, a comment, the continuation of a line ending in "\", or starts with a word in COMMANDS
//  3. a command line's comment holds no command of claimseed's own (a command line joined onto the comment before it)
// Usage: node scripts/check-markdown.js [ROOT]   (exit 1 and one line per problem when any is found)
import fs from 'fs'; import path from 'path';
import { repoRoot } from './lib/repo-root.js';
import { isMain } from './lib/is-main.js';

// The words a command line may start with. A block that needs another command adds its word here.
export const COMMANDS = ['node', 'npx', 'npm', 'docker', 'cd', 'mkdir', 'git', 'unzip', 'shasum', 'sha256sum'];
// a command run into a comment: node on the CLI or a package path, or npx (with any options) on a claimseed package
const SWALLOWED = / node src\/cli\.js | node packages\/| npx .*@claimseed\//;

// the cells of a table row: unescaped "|" outside code spans
export function cellCount(row) {
  let n = 0; let code = 0;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') { let k = 1; while (row[i + k] === '`') k++; code = code === 0 ? k : (code === k ? 0 : code); i += k - 1; continue; }
    if (c === '|' && code === 0) n++;
  }
  return n;
}

const startsCommand = (l) => COMMANDS.includes(l.trim().split(/\s+/)[0]);
const comment = (l) => { const m = l.match(/(?:^|\s)#(?:\s|$)(.*)$/); return m ? ' ' + m[1] + ' ' : null; };

function commandBlockProblems(lines, start, out) {
  lines.forEach((l, k) => {
    const prev = k > 0 ? lines[k - 1] : '';
    const t = l.trim();
    if (t !== '' && !t.startsWith('#') && !prev.trimEnd().endsWith('\\') && !startsCommand(l)) {
      out.push({ line: start + k, rule: 'command', text: 'a line of a command block is not a command, a comment or a continuation (add its first word to COMMANDS if it is a command)' });
    }
    const c = t.startsWith('#') ? ' ' + t.slice(1) + ' ' : comment(l);
    if (c && SWALLOWED.test(c)) out.push({ line: start + k, rule: 'command', text: 'a comment holds a command' });
  });
}

// problems of one file's text: [{ line, rule, text }], line numbers from 1
export function markdownProblems(text) {
  const L = text.split('\n'); const out = [];
  let i = 0;
  while (i < L.length) {
    const l = L[i];
    const fence = l.match(/^\s*```(\w*)/);
    if (fence) {
      let j = i + 1; while (j < L.length && !/^\s*```/.test(L[j])) j++;
      if (['sh', 'bash'].includes(fence[1])) commandBlockProblems(L.slice(i + 1, j), i + 2, out);
      i = j + 1; continue;
    }
    // a four-space indented block after a blank line, checked when it holds a command
    if (/^ {4}\S/.test(l) && (i === 0 || L[i - 1].trim() === '')) {
      let j = i; while (j < L.length && (/^ {4}/.test(L[j]) || (L[j].trim() === '' && j + 1 < L.length && /^ {4}\S/.test(L[j + 1])))) j++;
      const block = L.slice(i, j).map((x) => x.slice(4));
      if (block.some(startsCommand)) commandBlockProblems(block, i + 1, out);
      i = j; continue;
    }
    if (l.startsWith('|') && i + 1 < L.length && /^\|\s*:?-{3,}/.test(L[i + 1])) {
      const want = cellCount(l); let j = i + 1;
      // the table runs to the next blank line; a line in it that is not a row is a row broken across lines
      while (j < L.length && L[j].trim() !== '') {
        if (!L[j].startsWith('|')) out.push({ line: j + 1, rule: 'table', text: 'a line inside a table is not a row' });
        else if (cellCount(L[j]) !== want) out.push({ line: j + 1, rule: 'table', text: 'a table row has another number of cells than its header' });
        j++;
      }
      i = j; continue;
    }
    i++;
  }
  return out;
}

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn); else if (e.isFile() && e.name.endsWith('.md')) fn(p);
  }
}

if (isMain(import.meta.url)) {
  const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : repoRoot();
  let bad = 0; let files = 0;
  walk(ROOT, (p) => {
    files++;
    for (const x of markdownProblems(fs.readFileSync(p, 'utf-8'))) { bad++; console.log(`${path.relative(ROOT, p)}:${x.line}: ${x.rule}: ${x.text}`); }
  });
  console.log(`check-markdown: ${files} Markdown files, ${bad} problem(s)`);
  process.exit(bad ? 1 : 0);
}
