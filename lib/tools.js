/* ─────────────────────────────────────────────────────────────────────────
   dsh-search-enhance · 工具注册

   三个工具，各补官方 web_search 的一块短板：
     dsh_search_many   一次问遍多个查询 / 多个后端，带缓存
     dsh_search_read   批量抓网页正文，只回相关段落
     dsh_search_local  本地代码与文档的倒排索引检索

   工具名必须匹配 ^[a-zA-Z0-9_-]+$，不能带点。
   ───────────────────────────────────────────────────────────────────────── */

import path from 'node:path';

import { SearchCache, cacheKey } from './cache.js';
import { BackendMemory, DEFAULT_STORE as DEFAULT_SITE_STORE } from './memory.js';
import { searchMany, readMany, formatSource, BACKENDS, defaultBackends } from './search.js';
import { TextIndex } from './index-local.js';
function text(value) {
  return [{ type: 'text', text: String(value ?? '') }];
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export function registerTools(ctx, options) {
  const disposables = [];
  const cache = new SearchCache(options.cacheFile, { ttlMs: options.ttlMs });
  /** 记住挂掉的后端，下一轮 0ms 跳过（不传就退化成每次都重试） */
  const memory = options.memory ?? new BackendMemory(options.memoryFile ?? DEFAULT_SITE_STORE);
  /** 本地索引按根目录缓存，切目录不用重建别的 */
  const localIndexes = new Map();

  const register = (spec) => {
    disposables.push(ctx.tools.register(spec));
  };

  // 从代码里推出「默认用哪几个」，别硬编码——后端换过好几轮，写死的文案会过期
  const zhDefault = defaultBackends('中文查询').map((n) => BACKENDS[n]?.label ?? n).join('+');
  const enDefault = defaultBackends('english query').map((n) => BACKENDS[n]?.label ?? n).join('+');

  // ── dsh_search_many ─────────────────────────────────────────────
  register({
    name: 'dsh_search_many',
    description: [
      '一次跑多个查询和多个检索后端，并发执行并合并去重，结果按查询缓存 6 小时。',
      '官方 web_search 每次只走一个后端、最多 4 个查询、不缓存；同一个问题问第二遍还得重新等。',
      '这里的用途是「一次问全」：把想找的几个角度一起丢进来，一次往返拿回来，重复查询直接命中缓存。',
      `内置后端：${Object.keys(BACKENDS).join('、')}（免费、无需 key）。`,
      '后端可用性随本机网络和对方反爬策略变化，以 dsh_search_status 的实测状态为准。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          description: '要查的查询，1–8 个。会并发跑，顺序不影响速度。',
        },
        maxResults: { type: 'integer', description: '最多返回几个来源，默认 10，范围 1–30。' },
        backends: {
          type: 'array',
          items: { type: 'string', enum: Object.keys(BACKENDS) },
          description: `用哪些后端。不给就按查询语言自动挑：中文用 ${zhDefault}，英文用 ${enDefault}。可选：${Object.keys(BACKENDS).join('、')}。`,
        },
        refresh: { type: 'boolean', description: 'true 则跳过缓存，强制重新查。' },
      },
      required: ['queries'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const queries = [...new Set((args?.queries ?? []).map((q) => String(q).trim()).filter(Boolean))].slice(0, 8);
      if (queries.length === 0) return '没有给出查询（queries 不能为空）';
      const maxResults = clampInt(args?.maxResults, 1, 30, 10);
      const backends = Array.isArray(args?.backends) && args.backends.length ? args.backends : undefined;
      const refresh = args?.refresh === true;

      const lines = [];
      const pending = [];

      // 先过缓存：命中的直接进结果，没命中的攒起来一次并发
      for (const q of queries) {
        const key = cacheKey(q, maxResults);
        const hit = refresh ? null : cache.get(key);
        if (hit) {
          lines.push(`【缓存】${q}（${Math.round(hit.ageMs / 1000)}s 前查过）`);
          pending.push({ q, key, cached: hit.value });
        } else {
          pending.push({ q, key });
        }
      }

      const fresh = pending.filter((p) => !p.cached);
      let fetched = { sources: [], errors: [], perBackend: [], results: [], totalMs: 0 };
      if (fresh.length > 0) {
        fetched = await searchMany(fresh.map((p) => p.q), {
          backends,
          maxResults,
          signal: exec?.signal,
          memory,
        });
      }

      // 把新结果按「哪个查询 / 哪个后端」分回各自头上。
      // searchMany 的 results 里带着 query 和 backend，直接对得上，
      // 不用靠关键词猜测而已——猜不准会把 A 查询的结果算到 B 头上。
      for (const p of fresh) {
        const mine = [];
        const seenUrl = new Set();
        for (const r of fetched.results) {
          if (r.query !== p.q || r.error) continue;
          for (const s of r.sources) {
            if (!s?.url || seenUrl.has(s.url)) continue;
            seenUrl.add(s.url);
            mine.push({ ...s, backends: [r.name] });
          }
        }
        const value = { sources: mine.slice(0, maxResults), at: Date.now() };
        cache.set(p.key, value);
        p.fresh = value;
        // 后端自己吐了错（超时 / 结构变了），单独留一份给下面报告
        p.errors = fetched.results.filter((r) => r.query === p.q && r.error);
      }
      cache.save();

      for (const p of pending) {
        const value = p.cached ?? p.fresh ?? { sources: [] };
        if (!p.cached) lines.push(`【新查】${p.q}`);
        if (value.sources.length === 0) {
          const why = p.errors?.length
            ? `全部后端失败：${p.errors.map((e) => `${BACKENDS[e.name]?.label ?? e.name} ${e.error}`).join('；')}`
            : '这个查询没有结果';
          lines.push(`  （${why}）`);
        } else {
          value.sources.forEach((s, i) => lines.push(formatSource(s, i + 1)));
        }
        lines.push('');
      }

      const cachedCount = pending.length - fresh.length;
      const backendNote = fetched.perBackend.length > 0
        ? `后端：${fetched.perBackend.map((b) => `${b.label} ${b.ok}/${b.queries}`).join('，')}`
        : '';
      const skipNote = (fetched.skipped?.length ?? 0) > 0
        ? `；${[...new Set(fetched.skipped.map((s) => s.backend))].join('、')} 本轮按记忆跳过（还没到重试时间）`
        : '';
      lines.push(`（${pending.length} 个查询，缓存命中 ${cachedCount}，新查耗时 ${fetched.totalMs}ms${backendNote ? `；${backendNote}` : ''}${skipNote}）`);
      return lines.join('\n');
    },
  });

  // ── dsh_search_read ─────────────────────────────────────────────
  register({
    name: 'dsh_search_read',
    description: [
      '批量抓网页，剥掉导航/脚本/样式，只返回和查询词相关的正文段落。',
      'read_page 一次一个 URL、整页原样回来；开五个标签页找资料时，串行等待和无关正文都是纯浪费。',
      '这里并发抓、并发抽，按查询词挑最相关的 3 段，直接是能用的那一截。',
      '抓回来发现是 SPA 空壳（正文 < 200 字）会如实报告，不会假装成功。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: '要读的网页地址，1–10 个。并发抓。',
        },
        query: { type: 'string', description: '你关心什么。用来挑相关段落；留空则取正文开头。' },
        maxChars: { type: 'integer', description: '每个 URL 最多返回多少字，默认 2000，范围 200–8000。' },
        timeoutMs: { type: 'integer', description: '每个 URL 的超时，默认 8000，范围 1000–30000。' },
      },
      required: ['urls'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const urls = [...new Set((args?.urls ?? []).map((u) => String(u).trim()).filter(Boolean))].slice(0, 10);
      if (urls.length === 0) return '没有给出地址（urls 不能为空）';
      const query = String(args?.query ?? '');
      const maxChars = clampInt(args?.maxChars, 200, 8000, 2000);
      const timeoutMs = clampInt(args?.timeoutMs, 1000, 30000, 8000);

      const { pages, totalMs, terms } = await readMany(urls, query, { maxChars, timeoutMs, signal: exec?.signal });

      const lines = [];
      if (terms.length > 0) lines.push(`关键词：${terms.slice(0, 12).join(' / ')}`);
      for (const p of pages) {
        lines.push('');
        if (!p.ok) {
          lines.push(`✗ ${p.url}`);
          lines.push(`  ${p.reason}（${p.ms}ms）`);
          continue;
        }
        lines.push(`✓ ${p.title ? `${p.title} — ` : ''}${p.url}`);
        lines.push(`  正文 ${p.chars} 字，命中 ${p.hits} 处，${p.ms}ms`);
        for (const s of p.snippets) {
          lines.push('  ───');
          for (const row of s.split('\n')) lines.push(`  ${row}`);
        }
      }
      const okCount = pages.filter((p) => p.ok).length;
      lines.push('');
      lines.push(`（${pages.length} 个地址，成功 ${okCount}，总计 ${totalMs}ms）`);
      return lines.join('\n');
    },
  });

  // ── dsh_search_local ────────────────────────────────────────────
  register({
    name: 'dsh_search_local',
    description: [
      '在本地目录里建倒排索引并检索代码/文档，返回文件路径、行号和原文。',
      '文件工具一次读一个文件，「在所有笔记里找提到 XX 的地方」只能靠人翻。grep 每查一次就扫一遍盘。',
      '这里扫一次建好索引（只读一次盘），之后每次查询都是内存交集，毫秒级；索引按目录缓存在进程内。',
      `跳过 node_modules/.git/dist 等目录，只索引常见文本扩展名，单文件上限 512KB。`,
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词。多个词用空格分开表示「都要出现」；中文按二元组匹配。' },
        root: { type: 'string', description: '在哪个目录下找。默认当前工作目录。' },
        maxResults: { type: 'integer', description: '最多返回几处，默认 20，范围 1–100。' },
        contextLines: { type: 'integer', description: '每处前后各带几行上下文，默认 0，范围 0–3。' },
        rebuild: { type: 'boolean', description: 'true 则丢掉旧索引重建（改了大量文件后手动触发）。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: (_a, value) => text(value) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const query = String(args?.query ?? '').trim();
      if (!query) return '没有给出检索词（query 不能为空）';
      const root = String(args?.root || process.cwd());
      const maxResults = clampInt(args?.maxResults, 1, 100, 20);
      const contextLines = clampInt(args?.contextLines, 0, 3, 0);

      let index = localIndexes.get(root);
      let built = null;
      if (!index || args?.rebuild === true) {
        index = new TextIndex();
        index.root = root;
        const t0 = Date.now();
        built = index.build(root, { onProgress: () => {} });
        built.buildMs = Date.now() - t0;
        localIndexes.set(root, index);
        if (exec?.signal?.aborted) return '已取消';
      }

      const { hits, terms, candidates } = index.search(query, { maxResults, contextLines });

      const lines = [];
      lines.push(`索引：${root}`);
      if (built) {
        lines.push(`新建索引：${built.files} 个文件 / ${built.lines} 行 / ${built.terms} 个词，耗时 ${built.buildMs}ms`);
        if (built.skipped.length > 0) {
          lines.push(`跳过 ${built.skipped.length} 个文件（例：${path.basename(built.skipped[0].file)} — ${built.skipped[0].reason}）`);
        }
      } else {
        const s = index.summary();
        lines.push(`复用索引：${s.files} 个文件 / ${s.lines} 行，建于 ${Math.round((s.ageMs ?? 0) / 1000)}s 前`);
      }
      if (terms.length === 0) {
        lines.push('检索词切成空词表了（可能全是标点），换个词试试。');
        return lines.join('\n');
      }
      lines.push(`检索词：${terms.join(' / ')}`);
      lines.push('');

      if (hits.length === 0) {
        lines.push(`没找到。${candidates === 0 ? '' : `（候选 ${candidates} 行）`}`);
        return lines.join('\n');
      }
      for (const h of hits) {
        lines.push(`${h.file}:${h.line}`);
        lines.push(`  ${h.text.length > 300 ? `${h.text.slice(0, 300)}…` : h.text}`);
        for (const c of h.context) lines.push(`  ${c.line} | ${c.text.length > 200 ? `${c.text.slice(0, 200)}…` : c.text}`);
      }
      lines.push('');
      lines.push(`（命中 ${candidates} 行，显示前 ${hits.length} 条）`);
      return lines.join('\n');
    },
  });

  // ── dsh_search_status ───────────────────────────────────────────
  register({
    name: 'dsh_search_status',
    description: '看检索缓存、本地索引和内置后端现在什么状态。想知道"这个词是不是刚查过"或"索引建了没"时先看这里。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_a, value) => text(value) },
    isConcurrencySafe: () => true,
    async execute(args) {
      const lines = [];
      lines.push(`缓存文件：${cache.file}`);
      lines.push(`缓存条目：${cache.size} / ${cache.maxEntries}，TTL ${Math.round(cache.ttlMs / 3600000)} 小时`);
      const recent = cache.summary().slice(0, 5);
      for (const r of recent) {
        lines.push(`  ${r.key} — ${r.sources} 个来源，还有 ${Math.round(r.remainingMs / 60000)} 分钟过期`);
      }
      lines.push('');
      lines.push('内置后端：');
      for (const [name, b] of Object.entries(BACKENDS)) {
        const dead = memory.knownDead(name);
        const mins = dead ? Math.round(memory.deadRemainingMs(name) / 60000) : 0;
        lines.push(`  ${name} — ${b.label}（${b.kind}）${dead ? `  ⚠ 已判死，${mins} 分钟后重试` : ''}`);
      }
      const deadList = memory.summary().rows.filter((r) => r.dead);
      if (deadList.length > 0) {
        lines.push('');
        lines.push(`后端记忆：${memory.file}`);
        for (const r of deadList) lines.push(`  ${r.backend} — 失败 ${r.fails} 次，${Math.round(r.remainingMs / 60000)} 分钟后重试（${r.note}）`);
      }
      lines.push('');
      if (localIndexes.size === 0) {
        lines.push('本地索引：还没建过');
      } else {
        lines.push('本地索引：');
        for (const [root, idx] of localIndexes) {
          const s = idx.summary();
          lines.push(`  ${root} — ${s.files} 文件 / ${s.lines} 行 / ${s.terms} 词，${s.ageMs === null ? '未建' : `${Math.round(s.ageMs / 1000)}s 前`}`);
        }
      }
      return lines.join('\n');
    },
  });

  return {
    cache,
    dispose() {
      for (const d of disposables) {
        try {
          d?.dispose?.();
        } catch {
          /* 卸载时单条失败不影响其他 */
        }
      }
    },
  };
}
