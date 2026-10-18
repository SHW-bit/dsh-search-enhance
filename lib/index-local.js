/* ─────────────────────────────────────────────────────────────────────────
   dsh-search-enhance · 本地代码与文档检索

   官方的文件工具一次只读一个文件，想「在所有笔记里找提到 XX 的地方」
   就得靠人肉翻。这里给一个进程内的倒排索引：扫一遍目录，建好词表，
   以后每次查都只做内存里的交集，毫秒级。

   为什么是倒排而不是每次都 grep：
     grep 是 O(文件数 × 大小)，查十次就扫十次。搜索是交互式的，用户会
     连着改关键词，索引只建一次才能把「第 2 次搜索」压到 0。

   为什么不用 ripgrep 子进程：
     零依赖、跨平台、不依赖用户装了什么。文件数在几千以内，纯 JS 完全够。

   为什么按行存而不是按文件：
     命中位置要能定位到行号，否则结果没法直接用。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';

/** 只索引这些扩展名。二进制和图片进索引只会污染词表。 */
export const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.rst', '.adoc',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonc',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.html', '.htm', '.css', '.scss', '.less', '.vue', '.svelte', '.astro',
  '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.xml', '.svg',
  '.sql', '.tex', '.lua', '.php', '.r', '.m', '.mm', '.ex', '.exs',
]);

/** 这些目录整棵跳过，进去只会白花时间。 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  'coverage', '.gradle', 'vendor', '.pnpm-store', '.turbo',
]);

/** 超过这个大小的文件不索引——多半是压缩产物或数据文件。 */
export const MAX_FILE_BYTES = 512 * 1024;

/** 单文件最大行数，防止一行几万字的 log 拖垮索引。 */
export const MAX_LINES_PER_FILE = 4000;

/**
 * 把一个字符串切成检索词。
 *
 * 英文/数字按 `[a-z0-9_$]+` 切；中文没有空格，切二元组。
 * 两份词表都进倒排，查询时两边都能命中。
 */
export function tokenize(line) {
  const tokens = [];
  const low = String(line).toLowerCase();
  const re = /[a-z0-9_$]+/g;
  let m;
  while ((m = re.exec(low)) !== null) tokens.push(m[0]);
  // 中文按连续汉字段切二元组
  const zh = low.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const seg of zh) {
    const chars = [...seg];
    if (chars.length === 1) tokens.push(seg);
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

/** 递归列出要索引的文件。 */
export function listFiles(root, { maxFiles = 20000 } = {}) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(full);
      } else if (ent.isFile()) {
        if (!TEXT_EXTS.has(path.extname(ent.name).toLowerCase())) continue;
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

export class TextIndex {
  constructor() {
    /** @type {string[]} 行内容，下标即行 id */
    this.lines = [];
    /** @type {string[]} 行 id → 文件路径 */
    this.fileOf = [];
    /** @type {number[]} 行 id → 行号（1 起） */
    this.lineOf = [];
    /** @type {Map<string, number[]>} 词 → 行 id 列表 */
    this.postings = new Map();
    this.files = [];
    this.builtAt = 0;
    this.buildMs = 0;
  }

  get lineCount() {
    return this.lines.length;
  }

  /** 清空重建。`onProgress(done, total)` 可选。 */
  build(root, { maxFiles = 20000, onProgress } = {}) {
    const t0 = Date.now();
    this.lines = [];
    this.fileOf = [];
    this.lineOf = [];
    this.postings = new Map();
    this.files = listFiles(root, { maxFiles });

    const skipped = [];
    this.files.forEach((file, idx) => {
      let text;
      try {
        const st = fs.statSync(file);
        if (st.size > MAX_FILE_BYTES) {
          skipped.push({ file, reason: `超过 ${MAX_FILE_BYTES / 1024}KB` });
          return;
        }
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        skipped.push({ file, reason: String(error?.message || error) });
        return;
      }
      const rows = text.split(/\r?\n/).slice(0, MAX_LINES_PER_FILE);
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (row.length === 0) continue;
        const id = this.lines.length;
        this.lines.push(row);
        this.fileOf.push(file);
        this.lineOf.push(i + 1);
        for (const token of tokenize(row)) {
          let list = this.postings.get(token);
          if (!list) {
            list = [];
            this.postings.set(token, list);
          }
          // 同一行里重复出现只记一次，够用来排序了
          if (list[list.length - 1] !== id) list.push(id);
        }
      }
      if (onProgress && idx % 200 === 0) onProgress(idx, this.files.length);
    });

    this.builtAt = Date.now();
    this.buildMs = this.builtAt - t0;
    return { files: this.files.length, lines: this.lineCount, terms: this.postings.size, skipped, buildMs: this.buildMs };
  }

  /**
   * 查询。多个词取交集（都出现才算命中），同义词顺序不影响结果。
   *
   * 中文用户输入的「中文分词」整体是 4 个字，而倒排只按二元组建词，直接
   * 拿整串去查必然落空。所以整串先当键试一次，落空就退到它切出来的
   * 二元组。这不是模糊匹配：命中仍是「这些二元组都出现」的严格交集。
   *
   * @param {string} query
   * @param {{maxResults?: number, contextLines?: number}} opts
   */
  search(query, { maxResults = 20, contextLines = 0 } = {}) {
    const raw = [...new Set(
      String(query).split(/\s+/).filter(Boolean).map((t) => t.toLowerCase()),
    )];
    if (raw.length === 0) return { hits: [], terms: [], candidates: 0 };

    const lookup = (terms) => {
      // 从最短的列表开始求交集，能少扫很多
      const lists = terms
        .map((t) => this.postings.get(t))
        .filter(Boolean)
        .sort((a, b) => a.length - b.length);
      if (lists.length === 0) return [];
      let acc = new Set(lists[0]);
      for (let i = 1; i < lists.length && acc.size > 0; i += 1) {
        const next = new Set(lists[i]);
        acc = new Set([...acc].filter((id) => next.has(id)));
      }
      return [...acc];
    };

    // 1) 整串当键（英文单词、下划线标识符都在这条路上）
    let terms = raw;
    let ids = lookup(terms);

    // 2) 落空的中文词退到二元组
    if (ids.length === 0) {
      const fallback = [...new Set(raw.flatMap((t) => (/[\u4e00-\u9fa5]/.test(t) ? tokenize(t) : [t])))];
      if (fallback.length !== terms.length || fallback.some((t, i) => t !== terms[i])) {
        const ids2 = lookup(fallback);
        if (ids2.length > 0) {
          terms = fallback;
          ids = ids2;
        }
      }
    }

    // 3) 二元组也落空：退成并集，保证「词多多少少沾边」也能有结果
    if (ids.length === 0 && terms.length > 1) {
      const union = new Set();
      for (const t of terms) for (const id of this.postings.get(t) ?? []) union.add(id);
      if (union.size > 0) ids = [...union];
    }
    const hits = ids.slice(0, maxResults).map((id) => {
      const extra = [];
      for (let d = 1; d <= contextLines; d += 1) {
        const before = id - d;
        const after = id + d;
        if (before >= 0 && this.fileOf[before] === this.fileOf[id]) extra.push({ line: this.lineOf[before], text: this.lines[before] });
        if (after < this.lines.length && this.fileOf[after] === this.fileOf[id]) extra.push({ line: this.lineOf[after], text: this.lines[after] });
      }
      return {
        file: this.fileOf[id],
        line: this.lineOf[id],
        text: this.lines[id],
        context: extra.sort((a, b) => a.line - b.line),
      };
    });

    return { hits, terms, candidates: ids.length };
  }

  summary() {
    return {
      root: this.root ?? null,
      files: this.files.length,
      lines: this.lineCount,
      terms: this.postings.size,
      builtAt: this.builtAt,
      ageMs: this.builtAt ? Date.now() - this.builtAt : null,
      buildMs: this.buildMs,
    };
  }
}
