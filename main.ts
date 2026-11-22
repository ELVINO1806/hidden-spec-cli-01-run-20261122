// mend: one command-line tool that applies AI-written edits, in four formats,
// to a tree of text files. Written from SPEC.md (version 1). Node 22,
// standard library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** The patch cannot be read in its format; `line` is the 1-based patch line. */
class ParseErr {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit failed; `code` is the SPEC.md failure code, `path` the path it concerns. */
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** SPEC.md section 3: a path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or .. */
function isSafe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileView {
  lines: string[];
  br: string;
  fin: boolean;
}

function viewFile(text: string): FileView {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function renderFile(v: FileView): string {
  if (v.lines.length === 0) return '';
  return v.lines.join(v.br) + (v.fin ? v.br : '');
}

/** The tree as the edits leave it: `cur` holds changed paths (null: deleted). */
class Tree {
  private readonly disk = new Map<string, string | null>();
  cur = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
  read(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }
  get(p: string): string | null {
    return this.cur.has(p) ? this.cur.get(p)! : this.read(p);
  }
}

type Edit = (tree: Tree) => void;

/** SPEC.md section 4: detect the patch format, or null when none fits. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Line matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

function stripLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where `old` occurs in `lines` at one tier. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const found: number[] = [];
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (stripLine(lines[i + j]!, tier) !== stripLine(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** First tier (0, then 1, then 2; only 0 when strict) at which `old` occurs, with its positions. */
function locate(lines: string[], old: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, old, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** First occurrence of `old` at or after `from`, at the first tier with one. */
function locateFrom(lines: string[], old: string[], from: number, strict: boolean): { tier: number; at: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, old, t).filter((i) => i >= from);
    if (at.length > 0) return { tier: t, at: at[0]! };
  }
  return null;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/**
 * Build the replacement for the matched lines at `at`: context lines are the
 * file's own matched lines; at tier 2 every other line is re-indented from the
 * old block's leading whitespace to the file's (SPEC.md section 5).
 * `ctx[i]` marks new lines that are context lines, `oldIdx[i]` their index in `old`.
 */
function buildReplacement(fileLines: string[], at: number, old: string[], nw: string[], ctx: boolean[], oldIdx: number[], tier: number): string[] {
  const f = leadingWs(fileLines[at]!);
  const p = leadingWs(old[0]!);
  return nw.map((ln, i) => {
    if (ctx[i]) return fileLines[at + oldIdx[i]!]!;
    if (tier === 2 && ln !== '' && ln.trim() !== '' && ln.startsWith(p)) return f + ln.slice(p.length);
    return ln;
  });
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  hasOld: boolean;
  hasNew: boolean;
  diffOld: string | null;
  diffNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: text after the four characters, up to the first tab, trimmed; /dev/null means no file. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function isDiffGitLine(line: string): boolean {
  return line.startsWith('diff --git ') || line === 'diff --git';
}

/** `diff --git a/<X> b/<Y>`, or a parse error at its line when it is not of that form. */
function parseDiffGit(line: string, idx: number): { old: string | null; nw: string | null } {
  if (!line.startsWith('diff --git a/')) throw new ParseErr(idx + 1);
  const rest = line.slice('diff --git a/'.length);
  const sep = rest.indexOf(' b/');
  if (sep < 0) throw new ParseErr(idx + 1);
  const old = rest.slice(0, sep);
  const nw = rest.slice(sep + 3);
  if (old === '' || nw === '') throw new ParseErr(idx + 1);
  return { old, nw };
}

/** A hunk starting at `lines[i]`; returns the hunk and the index after its body. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]!);
  if (m === null) throw new ParseErr(i + 1);
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      if (l === '') body.push({ kind: ' ', text: '' });
      else body.push({ kind: l[0] as BodyLine['kind'], text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
  return { hunk: { a: Number(m[1]), body }, next: j };
}

function newUniSection(): UniSection {
  return {
    pairOld: null,
    pairNew: null,
    hasOld: false,
    hasNew: false,
    diffOld: null,
    diffNew: null,
    renameFrom: null,
    renameTo: null,
    create: false,
    remove: false,
    hunks: [],
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let hasPair = false;
  const start = (sec: UniSection): void => {
    sections.push(sec);
    cur = sec;
    inHeader = true;
  };
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i]!;
    if (isDiffGitLine(ln)) {
      const d = parseDiffGit(ln, i);
      const sec = newUniSection();
      sec.diffOld = d.old;
      sec.diffNew = d.nw;
      start(sec);
      hasPair = false;
      i++;
      continue;
    }
    if (cur === null) {
      if (ln.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        const sec = newUniSection();
        sec.pairOld = headerPath(ln);
        sec.pairNew = headerPath(lines[i + 1]!);
        sec.hasOld = true;
        sec.hasNew = true;
        start(sec);
        hasPair = true;
        i += 2;
        continue;
      }
      if (ln.startsWith('@@')) throw new ParseErr(i + 1);
      i++;
      continue;
    }
    if (inHeader) {
      if (ln.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ') === false) throw new ParseErr(i + 2);
        if (!hasPair) {
          cur.pairOld = headerPath(ln);
          cur.pairNew = headerPath(lines[i + 1]!);
          cur.hasOld = true;
          cur.hasNew = true;
          hasPair = true;
          i += 2;
          continue;
        }
        const sec = newUniSection();
        sec.pairOld = headerPath(ln);
        sec.pairNew = headerPath(lines[i + 1]!);
        sec.hasOld = true;
        sec.hasNew = true;
        start(sec);
        hasPair = true;
        i += 2;
        continue;
      }
      if (ln.startsWith('+++ ')) {
        cur.pairNew = headerPath(ln);
        cur.hasNew = true;
        i++;
        continue;
      }
      if (ln.startsWith('rename from ')) {
        cur.renameFrom = ln.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (ln.startsWith('rename to ')) {
        cur.renameTo = ln.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (ln.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (ln.startsWith('deleted file mode')) {
        cur.remove = true;
        i++;
        continue;
      }
      if (ln.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        i = h.next;
        inHeader = false;
        continue;
      }
      i++;
      continue;
    }
    if (ln.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec = newUniSection();
      sec.pairOld = headerPath(ln);
      sec.pairNew = headerPath(lines[i + 1]!);
      sec.hasOld = true;
      sec.hasNew = true;
      start(sec);
      hasPair = true;
      i += 2;
      continue;
    }
    if (ln.startsWith('@@')) {
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i++;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Whether a `\` line follows the hunk's last context or `+` line (no final line break then). */
function hunkNoEol(h: Hunk): boolean {
  let last = -1;
  for (let k = 0; k < h.body.length; k++) {
    if (h.body[k]!.kind === ' ' || h.body[k]!.kind === '+') last = k;
  }
  if (last < 0) return false;
  return h.body[last + 1] !== undefined && h.body[last + 1]!.kind === '\\';
}

/** Split a hunk body into its old lines O and new lines N, with the context map. */
function splitHunk(h: Hunk): { old: string[]; nw: string[]; ctx: boolean[]; oldIdx: number[] } {
  const old: string[] = [];
  const nw: string[] = [];
  const ctx: boolean[] = [];
  const oldIdx: number[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      old.push(b.text);
      nw.push(b.text);
      ctx.push(true);
      oldIdx.push(old.length - 1);
    } else if (b.kind === '-') {
      old.push(b.text);
    } else if (b.kind === '+') {
      nw.push(b.text);
      ctx.push(false);
      oldIdx.push(-1);
    }
  }
  return { old, nw, ctx, oldIdx };
}

/** Apply a section's hunks, in order, to a file's text; throws EditFail on a hunk failure. */
function applyHunks(sec: UniSection, text: string, path: string, strict: boolean): string {
  let st = viewFile(text);
  let d = 0;
  for (const h of sec.hunks) {
    const { old, nw, ctx, oldIdx } = splitHunk(h);
    const noEol = hunkNoEol(h);
    if (old.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, st.lines.length));
      const fin = pos === st.lines.length ? !noEol : st.fin;
      st = { lines: [...st.lines.slice(0, pos), ...nw, ...st.lines.slice(pos)], br: st.br, fin };
    } else {
      const loc = locate(st.lines, old, strict);
      if (loc === null) throw new EditFail('no-match', path);
      const target = h.a - 1 + d;
      let best = loc.at[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of loc.at) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const rep = buildReplacement(st.lines, best, old, nw, ctx, oldIdx, loc.tier);
      const fin = best + old.length === st.lines.length ? !noEol : st.fin;
      st = { lines: [...st.lines.slice(0, best), ...rep, ...st.lines.slice(best + old.length)], br: st.br, fin };
    }
    d += nw.length - old.length;
  }
  return renderFile(st);
}

// unifiedEdit: one section = one file (create, delete, change or move);
// strict narrows its hunks to tier-0 exact matches only.
function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree: Tree) => {
    const oldP = sec.hasOld ? sec.pairOld : (sec.renameFrom ?? sec.diffOld);
    const newP = sec.hasNew ? sec.pairNew : (sec.renameTo ?? sec.diffNew);
    if (oldP === null || sec.create) {
      if (newP === null) throw new EditFail('unsafe', '/dev/null');
      const np = newP;
      if (!isSafe(np)) throw new EditFail('unsafe', np);
      if (tree.get(np) !== null) throw new EditFail('exists', np);
      const plus: string[] = [];
      let lastPlus: { h: Hunk; idx: number } | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.kind === '+') {
            plus.push(h.body[k]!.text);
            lastPlus = { h, idx: k };
          }
        }
      }
      let noEol = false;
      if (lastPlus !== null) {
        const nxt = lastPlus.h.body[lastPlus.idx + 1];
        if (nxt !== undefined && nxt.kind === '\\') noEol = true;
      }
      tree.cur.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (newP === null || sec.remove) {
      if (oldP === null) throw new EditFail('unsafe', '/dev/null');
      const op = oldP;
      if (!isSafe(op)) throw new EditFail('unsafe', op);
      if (tree.get(op) === null) throw new EditFail('missing', op);
      tree.cur.set(op, null);
      return;
    }
    const op = oldP;
    const np = newP;
    if (op !== np) {
      if (!isSafe(op)) throw new EditFail('unsafe', op);
      if (!isSafe(np)) throw new EditFail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new EditFail('missing', op);
      if (tree.get(np) !== null) throw new EditFail('exists', np);
      const out = applyHunks(sec, before, op, strict);
      tree.cur.set(np, out);
      tree.cur.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    if (!isSafe(op)) throw new EditFail('unsafe', op);
    const before = tree.get(op);
    if (before === null) throw new EditFail('missing', op);
    tree.cur.set(op, applyHunks(sec, before, op, strict));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  old: string[];
  nw: string[];
}

// SEARCH/REPLACE: blocks carry their own old/new text; strict pins matching to tier 0.
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(searchIdx + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new ParseErr(searchIdx + 1);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new ParseErr(searchIdx + 1);
    blocks.push({ path, old: lines.slice(searchIdx + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  // each block becomes one edit; strict rides along to the matcher.
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree: Tree) => {
    const p = b.path;
    if (!isSafe(p)) throw new EditFail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.cur.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new EditFail('missing', p);
    const st = viewFile(before);
    const loc = locate(st.lines, b.old, strict);
    if (loc === null) throw new EditFail('no-match', p);
    if (loc.at.length > 1) throw new EditFail('ambiguous', p);
    const at = loc.at[0]!;
    const rep = buildReplacement(st.lines, at, b.old, b.nw, b.nw.map(() => false), b.nw.map(() => -1), loc.tier);
    tree.cur.set(p, renderFile({ lines: [...st.lines.slice(0, at), ...rep, ...st.lines.slice(at + b.old.length)], br: st.br, fin: st.fin }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VUpdate {
  path: string;
  moveTo: string | null;
  chunks: VChunk[];
}

// V4A: the cursor moves down the file as chunks apply; strict pins matching to tier 0.
function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const ln = lines[i]!;
    if (isBlank(ln)) {
      i++;
      continue;
    }
    if (ln.startsWith('*** Add File: ')) {
      const p = ln.slice('*** Add File: '.length).trim();
      const secLines: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        secLines.push(lines[j]!);
        j++;
      }
      while (secLines.length > 0 && isBlank(secLines[secLines.length - 1]!)) secLines.pop();
      const fileLines: string[] = [];
      for (let k = 0; k < secLines.length; k++) {
        const l = secLines[k]!;
        if (l === '') fileLines.push('');
        else if (l.startsWith('+')) fileLines.push(l.slice(1));
        else throw new ParseErr(i + 2 + k);
      }
      edits.push(((path: string, fl: string[]): Edit => (tree: Tree) => {
        if (!isSafe(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) !== null) throw new EditFail('exists', path);
        tree.cur.set(path, fl.length === 0 ? '' : fl.join('\n') + '\n');
      })(p, fileLines));
      i = j;
      continue;
    }
    if (ln.startsWith('*** Delete File: ')) {
      const p = ln.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        if (!isBlank(lines[j]!)) throw new ParseErr(j + 1);
        j++;
      }
      edits.push(((path: string): Edit => (tree: Tree) => {
        if (!isSafe(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) === null) throw new EditFail('missing', path);
        tree.cur.set(path, null);
      })(p));
      i = j;
      continue;
    }
    if (ln.startsWith('*** Update File: ')) {
      const p = ln.slice('*** Update File: '.length).trim();
      const secLines: string[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        secLines.push(lines[j]!);
        j++;
      }
      while (secLines.length > 0 && isBlank(secLines[secLines.length - 1]!)) secLines.pop();
      const upd: VUpdate = { path: p, moveTo: null, chunks: [] };
      let k = 0;
      if (k < secLines.length && secLines[k]!.startsWith('*** Move to: ')) {
        upd.moveTo = secLines[k]!.slice('*** Move to: '.length).trim();
        k++;
      }
      let firstChunk = true;
      let inChunk = false;
      let curChunk: VChunk | null = null;
      const openChunk = (anchor: string | null): void => {
        curChunk = { anchor, eof: false, body: [] };
        inChunk = true;
        firstChunk = false;
      };
      const closeChunk = (): void => {
        if (curChunk !== null) upd.chunks.push(curChunk);
        curChunk = null;
        inChunk = false;
      };
      while (k < secLines.length) {
        const l = secLines[k]!;
        const lineNo = i + 2 + k;
        if (!inChunk) {
          if (l.startsWith('@@')) {
            openChunk(l.slice(2).trim());
            k++;
            continue;
          }
          if (l === '*** End of File') throw new ParseErr(lineNo);
          if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
            if (!firstChunk) throw new ParseErr(lineNo);
            openChunk(null);
            continue;
          }
          throw new ParseErr(lineNo);
        }
        if (l.startsWith('@@')) {
          closeChunk();
          openChunk(l.slice(2).trim());
          k++;
          continue;
        }
        if (l === '*** End of File') {
          curChunk!.eof = true;
          closeChunk();
          k++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          curChunk!.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0] as BodyLine['kind'], text: l.slice(1) });
          k++;
          continue;
        }
        throw new ParseErr(lineNo);
      }
      if (inChunk) closeChunk();
      if (upd.chunks.length === 0 && upd.moveTo === null) throw new ParseErr(i + 1);
      // one parsed update = one edit, strict carried into its chunks.
      edits.push(v4aUpdateEdit(upd, strict));
      i = j;
      continue;
    }
    throw new ParseErr(i + 1);
  }
  return edits;
}

// v4aUpdateEdit: one V4A update block, applied chunk by chunk from the cursor;
// strict narrows every chunk's anchor search to tier-0 exact matches.
function v4aUpdateEdit(upd: VUpdate, strict: boolean): Edit {
  return (tree: Tree) => {
    const p = upd.path;
    if (!isSafe(p)) throw new EditFail('unsafe', p);
    if (upd.moveTo !== null && !isSafe(upd.moveTo)) throw new EditFail('unsafe', upd.moveTo);
    const before = tree.get(p);
    if (before === null) throw new EditFail('missing', p);
    if (upd.moveTo !== null && tree.get(upd.moveTo) !== null) throw new EditFail('exists', upd.moveTo);
    let st = viewFile(before);
    let cursor = 0;
    for (const ch of upd.chunks) {
      if (ch.anchor !== null) {
        const found = locateFrom(st.lines, [ch.anchor], cursor, strict);
        if (found === null) throw new EditFail('no-match', p);
        cursor = found.at + 1;
      }
      const { old, nw, ctx, oldIdx } = splitHunk({ a: 0, body: ch.body });
      if (old.length === 0) {
        const pos = ch.eof ? st.lines.length : cursor;
        st = { lines: [...st.lines.slice(0, pos), ...nw, ...st.lines.slice(pos)], br: st.br, fin: st.fin };
        cursor = pos + nw.length;
      } else {
        let found: { tier: number; at: number } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const occ = occurrences(st.lines, old, t).filter((i) => i >= cursor);
          if (ch.eof) {
            const last = occ.filter((i) => i + old.length === st.lines.length);
            if (last.length > 0) {
              found = { tier: t, at: last[0]! };
              break;
            }
          } else if (occ.length > 0) {
            found = { tier: t, at: occ[0]! };
            break;
          }
        }
        if (found === null) throw new EditFail('no-match', p);
        const rep = buildReplacement(st.lines, found.at, old, nw, ctx, oldIdx, found.tier);
        st = { lines: [...st.lines.slice(0, found.at), ...rep, ...st.lines.slice(found.at + old.length)], br: st.br, fin: st.fin };
        cursor = found.at + nw.length;
      }
    }
    const out = renderFile(st);
    if (upd.moveTo !== null) {
      tree.cur.set(upd.moveTo, out);
      tree.cur.set(p, null);
      tree.moves.push([p, upd.moveTo]);
    } else {
      tree.cur.set(p, out);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.cur.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const crlf = viewFile(before).br === '\r\n';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      const nw = toLf(newStr);
      let count = 0;
      let at = -1;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        count++;
        if (at < 0) at = k;
      }
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const out = t.slice(0, at) + nw + t.slice(at + old.length);
      tree.cur.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const st = viewFile(before);
      if (lineNo < 0 || lineNo > st.lines.length) throw new EditFail('no-match', p);
      const ls = [...st.lines];
      ls.splice(lineNo, 0, ...add);
      tree.cur.set(p, renderFile({ lines: ls, br: st.br, fin: st.fin }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseErr(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseErr(first + 1);
      edits.push(e);
    }
    return edits;
  }
  for (let idx = 0; idx < lines.length; idx++) {
    const l = lines[idx]!;
    if (isBlank(l)) continue;
    let v: unknown;
    try {
      v = JSON.parse(l);
    } catch {
      throw new ParseErr(idx + 1);
    }
    const e = jsonEdit(v);
    if (e === null) throw new ParseErr(idx + 1);
    edits.push(e);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Driver (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

// parsePatch: dispatch on the detected (or forced) format; strict passes through.
function parsePatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  if (kind === 'v4a') return parseV4a(lines, strict);
  return parseJson(text, lines);
}

function usage(): { code: number; out: string[] } {
  return { code: 2, out: ['error: usage'] };
}

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usage();
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usage();
        format = v;
      } else if (a === '--check') {
        if (check) return usage();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usage();
        strict = true;
      } else {
        return usage();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usage();
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = parsePatch(kind, text, lines, strict);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const ed of edits) {
    const snap = new Map(tree.cur);
    const snapMoves = tree.moves.length;
    try {
      ed(tree);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.cur = snap;
      tree.moves.length = snapMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const status = new Map<string, 'A' | 'D' | 'M'>();
  for (const p of tree.cur.keys()) {
    const was = tree.read(p);
    const now = tree.cur.get(p)!;
    if (was === now) continue;
    status.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const movePairs = tree.moves.filter(([o, n]) => status.get(o) === 'D' && status.get(n) === 'A');
  const movedOld = new Set(movePairs.map(([o]) => o));
  const movedNew = new Set(movePairs.map(([, n]) => n));
  const rows: { key: string; line: string }[] = [];
  for (const [p, s] of status) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, line: `${s} ${p}` });
  }
  for (const [o, n] of movePairs) rows.push({ key: n, line: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const [p] of status) {
      const now = tree.cur.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
