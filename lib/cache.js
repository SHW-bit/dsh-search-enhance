/* ─────────────────────────────────────────────────────────────────────────
   dsh-search-enhance · 检索缓存

   官方 web_search 每次调用都直接打 provider，同一句话搜一百次就是一百次
   网络往返。这里做一层进程内 + 落盘的 LRU 缓存，键是「归一化后的查询
   文本 + 条数上限」，值是 provider 返回的原始结构。

   为什么键要带条数上限：`maxResults` 变了返回条数就变了，不能混用。

   为什么落盘：一次会话里搜过的东西，下一个会话还想用。缓存存在
   ~/.dsh/search-enhance/cache.json，超过 TTL 或容量上限就淘汰。

   为什么不用 Map 直接当 LRU：JSON 落盘要保持插入顺序，所以用数组存
   顺序、对象存数据，读的时候把命中的条目前移。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认 6 小时。检索结果不像图片那样转瞬即逝，但也不该永远缓存。 */
export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

/** 默认最多存 300 条查询。一条结果 8 个源、每个源几百字节，300 条约 2MB。 */
export const DEFAULT_MAX_ENTRIES = 300;

/** 缓存文件的位置。放在 profile 之外的独立目录，卸载插件不会误删别的。 */
export function defaultCachePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'search-enhance', 'cache.json');
}

/**
 * 把查询文本归一化成缓存键：去首尾空白、内部连续空白压成一个、转小写。
 * 大小写和多余空格在检索语义上没有区别，不该让它们变成两条缓存。
 */
export function normalizeQuery(query) {
  return String(query).trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 缓存键 = 归一化查询 + 条数上限。 */
export function cacheKey(query, maxResults) {
  return `${normalizeQuery(query)}::${Number(maxResults) || 0}`;
}

export class SearchCache {
  constructor(file = defaultCachePath(), { ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    /** @type {Array<{key: string, at: number, value: any}>} 新→旧 */
    this.entries = [];
    this.load();
  }

  get size() {
    return this.entries.length;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(raw?.entries) ? raw.entries : [];
      const now = Date.now();
      this.entries = list
        .filter((e) => e && typeof e.key === 'string' && typeof e.at === 'number' && now - e.at < this.ttlMs)
        .slice(0, this.maxEntries);
    } catch {
      // 文件不存在 / 损坏 / 版本不符：当作空缓存，不抛
      this.entries = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, entries: this.entries }), 'utf8');
      return true;
    } catch {
      // 落盘失败不该让检索失败——内存里还有
      return false;
    }
  }

  /** 命中返回 `{value, ageMs}`，未命中或过期返回 null。命中即前移。 */
  get(key) {
    const idx = this.entries.findIndex((e) => e.key === key);
    if (idx === -1) return null;
    const entry = this.entries[idx];
    const ageMs = Date.now() - entry.at;
    if (ageMs >= this.ttlMs) {
      this.entries.splice(idx, 1);
      return null;
    }
    if (idx > 0) {
      this.entries.splice(idx, 1);
      this.entries.unshift(entry);
    }
    return { value: entry.value, ageMs };
  }

  set(key, value) {
    const idx = this.entries.findIndex((e) => e.key === key);
    if (idx !== -1) this.entries.splice(idx, 1);
    this.entries.unshift({ key, at: Date.now(), value });
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
    // 立即落盘：否则换个会话/进程就丢，缓存等于只在本次调用内有效
    this.save();
  }

  clear() {
    this.entries = [];
    this.save();
  }

  /** 清掉已过期的，返回清掉几条。 */
  prune() {
    const now = Date.now();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => now - e.at < this.ttlMs);
    return before - this.entries.length;
  }

  /** 给 sites 工具看的摘要。 */
  summary() {
    const now = Date.now();
    return this.entries.map((e) => ({
      key: e.key,
      ageMs: now - e.at,
      remainingMs: Math.max(0, this.ttlMs - (now - e.at)),
      sources: Array.isArray(e.value?.sources) ? e.value.sources.length : 0,
    }));
  }
}
