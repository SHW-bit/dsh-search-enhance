/* ─────────────────────────────────────────────────────────────────────────
   dsh-search-enhance · 多源并发检索

   官方 web_search 一次只能走一个 provider、最多 4 个查询。真实场景是
   「同一个问题想问遍几个源」，串行做就是 N 倍的等待。

   这里用 Node 自带的 fetch 并发打多个后端，最后合并去重。不引入第三方
   依赖——这个插件在别人机器上也要能装。

   ⚠️ 内置后端是「本机实测能连上、且结果能被解析」的那几个，不是「理论上
   最好」的那几个：
     · Wikipedia / DuckDuckGo / Brave / Startpage / searx：本机 10.5 秒硬
       超时，配成默认只会让每次检索白等一个超时
     · 百度：结果主要走 AI 卡片 + baidu.php 加密跳转，抓不到干净的
       「标题 / 链接 / 摘要」三元组
     · 搜狗：**已上反爬**，返回 antispider.min.js 的验证码页（5.4KB 空壳），
       带 cookie 和完整浏览器头都过不去。曾经能抓，现在不行了。
     · Stack Overflow / MDN 搜索页：Cloudflare 或前端渲染，正文里没有结果
     · 实测可用：Bing（英文最稳）、360（中文结果质量最好，链接带真实地址）、
       arXiv（论文原文）
   换网络环境后跑 `node _selftest_net.mjs` 重新看一遍再调整。
   ───────────────────────────────────────────────────────────────────────── */

import { extractText, pickRelevant, queryTerms } from './extract.js';

/** 每个后端一次最多等多久。死了就跳过，别拖住整体。 */
export const BACKEND_TIMEOUT_MS = 6000;

/** 搜索行为像浏览器，避免个别站按 UA 拦。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 去标签 + 解实体，搜索结果页里拿标题/摘要用。 */
function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 <style>/<script>/注释挖掉：不挖的话正则会一头栽进 CSS 里。 */
function skeleton(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

async function getText(url, signal, headers = {}) {
  const res = await fetch(url, { signal, redirect: 'follow', headers: { 'user-agent': UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 内置后端表。
 *
 * 只放「不需要 API key、公开可查、本机实测能用」的入口。
 * 每个后端返回统一形状：`{ title, url, snippet }`。
 */
export const BACKENDS = {
  /** Bing 网页搜索：`<li class="b_algo">` 结构稳定，中英文都行。 */
  bing: {
    label: 'Bing',
    kind: 'web',
    async run(query, signal) {
      const html = skeleton(await getText(
        `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN`, signal));
      const out = [];
      const blocks = html.split('<li class="b_algo"').slice(1);
      for (const block of blocks) {
        if (out.length >= 8) break;
        const link = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!link) continue;
        const snip = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
        out.push({
          title: stripTags(link[2]),
          url: link[1].startsWith('http') ? link[1] : `https://www.bing.com${link[1]}`,
          snippet: snip ? stripTags(snip[1]).slice(0, 400) : '',
        });
      }
      if (out.length === 0) throw new Error('页面结构变了，没解析出结果');
      return out;
    },
  },

  /**
   * 360 搜索：中文结果质量好，结构是几个中文站里最干净的。
   * 链接带 `data-mdurl`，直接就是真实地址，不用解 so.com/link 跳转。
   */
  so360: {
    label: '360',
    kind: 'web',
    async run(query, signal) {
      const html = skeleton(await getText(`https://www.so.com/s?q=${encodeURIComponent(query)}`, signal, {
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      }));
      const out = [];
      const blocks = html.split(/<li class="res-list"/).slice(1);
      for (const block of blocks) {
        if (out.length >= 8) break;
        const h3 = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
        if (!h3) continue;
        const a = h3[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!a) continue;
        const title = stripTags(a[2]);
        if (!title) continue;
        // data-mdurl 才是真实地址；href 是 so.com/link 加密跳转
        const md = block.match(/data-mdurl="([^"]+)"/);
        const url = md ? md[1] : a[1];
        // 站内推荐（文库、问答聚合页）不是搜索结果
        if (/^(?:https?:\/\/)?(?:wenku|zhidao|www)\.so\.com\//.test(url)) continue;
        if (url.includes('so.com/link')) continue;
        const desc = block.match(/<(p|div)[^>]*class="res-desc"[^>]*>([\s\S]*?)<\/\1>/)
          || block.match(/data-result-summary[^>]*>([\s\S]*?)<\/span>/);
        const snippet = desc ? stripTags(desc[2] ?? desc[1]).slice(0, 400) : '';
        out.push({ title, url, snippet });
      }
      if (out.length === 0) throw new Error('页面结构变了，没解析出结果');
      return out;
    },
  },

  /**
   * 搜狗网页搜索。
   *
   * ⚠️ 当前**默认不用它**：搜狗已上反爬，请求会返回 antispider.min.js 的
   * 验证码页（约 5.4KB，h3 数为 0），纯 UA、带 cookie、完整浏览器头都过不去。
   * 保留这段解析是因为它的结构（`<h3 class="vr-title"><a>` + 紧随的摘要）
   * 没变，哪天反爬放松了可以立刻启用。用之前先跑 `_selftest_net.mjs` 确认
   * 能拿到结果，别把一个必然失败的站放进默认组白白多等一次往返。
   */
  sogou: {
    label: '搜狗',
    kind: 'web',
    async run(query, signal) {
      const html = skeleton(await getText(`https://www.sogou.com/web?query=${encodeURIComponent(query)}`, signal));
      const out = [];
      const re = /<h3[^>]*>([\s\S]*?)<\/h3>/g;
      let m;
      while ((m = re.exec(html)) !== null && out.length < 8) {
        const block = m[1];
        const a = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!a) continue;
        const title = stripTags(a[2]);
        if (!title) continue;
        // 摘要：h3 之后那一段文字，取到下一个结果块为止
        const after = html.slice(re.lastIndex, re.lastIndex + 2000);
        const p = after.match(/<(p|span|div)[^>]*>([\s\S]{20,600}?)<\/\1>/);
        out.push({
          title,
          url: a[1].startsWith('http') ? a[1] : `https://www.sogou.com${a[1]}`,
          snippet: p ? stripTags(p[2]).slice(0, 400) : '',
        });
      }
      if (out.length === 0) throw new Error('页面结构变了，没解析出结果');
      return out;
    },
  },

  /** arXiv：查论文。理工科问题直接给原始出处，比二手博客靠谱。 */
  arxiv: {
    label: 'arXiv',
    kind: 'paper',
    async run(query, signal) {
      // arXiv 的查询语法里 OR 是关键词，空格要显式拼成 +AND+
      const terms = query.split(/\s+/).filter(Boolean).map((t) => `all:${encodeURIComponent(t)}`);
      const xml = await getText(
        `http://export.arxiv.org/api/query?search_query=${terms.join('+AND+')}&max_results=5`, signal);
      const out = [];
      for (const e of xml.split('<entry>').slice(1)) {
        const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
        const id = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || '';
        const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '';
        if (!id) continue;
        out.push({ title: stripTags(title), url: id.trim(), snippet: stripTags(summary).slice(0, 400) });
      }
      if (out.length === 0) throw new Error('没解析出条目（可能没有匹配的论文）');
      return out;
    },
  },
};

/** 默认后端组：中文问题走 360 + Bing，英文问题走 Bing + 360。 */
export function defaultBackends(query) {
  return /[\u4e00-\u9fa5]/.test(query) ? ['so360', 'bing'] : ['bing', 'so360'];
}

/** 把一条结果压成「标题 + 链接 + 摘要」。 */
function formatSource(s, rank) {
  const lines = [`${rank}. [${s.title || s.url}](${s.url})`];
  if (s.snippet) lines.push(`   ${String(s.snippet).replace(/\s+/g, ' ').slice(0, 400)}`);
  if (s.backends && s.backends.length > 1) lines.push(`   （多个源都命中：${s.backends.join('、')}）`);
  return lines.join('\n');
}

/**
 * 并发跑多个后端 + 多个查询。
 *
 * 一个后端挂掉不影响别的：失败的那条记进 `errors`，成功的照常返回。
 * 两个排序键都保留原始 `query` / `backend`，调用方不用靠关键词猜归属。
 *
 * 传了 `memory` 就会记住挂掉的后端：已判死的直接 0ms 跳过，不再白等超时。
 * 这是实测中最容易拖慢的一件事——死站每轮都要等满 6 秒。
 *
 * @param {string[]} queries 查询（已去重）
 * @param {{backends?: string[], maxResults?: number, timeoutMs?: number, signal?: AbortSignal, memory?: import('./memory.js').BackendMemory}} opts
 * @returns {Promise<{sources: Array, errors: Array, results: Array, perBackend: Array, skipped: Array, totalMs: number}>}
 */
export async function searchMany(queries, opts = {}) {
  const started = Date.now();
  const maxResults = Math.max(1, Math.min(30, opts.maxResults ?? 10));
  const timeoutMs = opts.timeoutMs ?? BACKEND_TIMEOUT_MS;
  const memory = opts.memory;

  const jobs = [];
  /** 被站点记忆跳过、没真正发出去的 */
  const skipped = [];
  for (const query of queries) {
    const names = opts.backends?.length ? opts.backends : defaultBackends(query);
    for (const name of names) {
      const backend = BACKENDS[name];
      if (!backend) {
        jobs.push(Promise.resolve({ name, query, sources: [], error: `不认识的后端：${name}`, ms: 0 }));
        continue;
      }
      // 已知挂掉：0ms 跳过，别每轮再等一次超时
      if (memory?.knownDead(name)) {
        const mins = Math.round(memory.deadRemainingMs(name) / 60000);
        skipped.push({ backend: name, query, remainingMs: memory.deadRemainingMs(name) });
        jobs.push(Promise.resolve({
          name, query, sources: [],
          error: `后端记忆：该后端已判死（还有 ${mins} 分钟到期），本轮跳过`,
          skippedByMemory: true,
          ms: 0,
        }));
        continue;
      }
      jobs.push((async () => {
        const t0 = Date.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new Error('超时')), timeoutMs);
        const onAbort = () => ctrl.abort(new Error('已取消'));
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        try {
          const sources = await backend.run(query, ctrl.signal);
          memory?.markOk(name);
          return { name, query, sources, ms: Date.now() - t0 };
        } catch (error) {
          const reason = ctrl.signal.aborted
            ? (opts.signal?.aborted ? '已取消' : `超过 ${timeoutMs}ms`)
            : String(error?.cause?.code || error?.message || error);
          // 用户主动取消的别记成站点失败
          if (!opts.signal?.aborted) memory?.markFail(name, reason);
          return { name, query, sources: [], error: reason, ms: Date.now() - t0 };
        } finally {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onAbort);
        }
      })());
    }
  }

  const settled = await Promise.allSettled(jobs);
  const results = settled.map((s) =>
    s.status === 'fulfilled' ? s.value : { name: '?', query: '?', sources: [], error: String(s.reason), ms: 0 });

  // 合并去重：同 URL 只留第一次出现，但把后出现的更长摘要补上
  const seen = new Map();
  for (const r of results) {
    for (const s of r.sources) {
      if (!s?.url) continue;
      const prev = seen.get(s.url);
      if (!prev) {
        seen.set(s.url, { ...s, backends: [r.name], queries: [r.query] });
      } else {
        if (!prev.backends.includes(r.name)) prev.backends.push(r.name);
        if (!prev.queries.includes(r.query)) prev.queries.push(r.query);
        if ((s.snippet?.length ?? 0) > (prev.snippet?.length ?? 0)) prev.snippet = s.snippet;
      }
    }
  }
  const sources = [...seen.values()].slice(0, maxResults);

  const errors = results.filter((r) => r.error).map((r) => ({ backend: r.name, query: r.query, error: r.error }));
  const perBackend = [...new Set(results.map((r) => r.name))].map((name) => {
    const mine = results.filter((r) => r.name === name);
    return {
      backend: name,
      label: BACKENDS[name]?.label ?? name,
      queries: mine.length,
      ok: mine.filter((r) => !r.error).length,
      skipped: mine.filter((r) => r.skippedByMemory).length,
      ms: mine.reduce((a, r) => a + r.ms, 0),
    };
  });

  return { sources, errors, perBackend, results, skipped, totalMs: Date.now() - started };
}

/**
 * 给一批 URL 抽正文，按查询词挑相关段落。
 *
 * 抓失败、抽不出正文、抓到的是纯导航的，如实记 reason，不伪装成成功。
 *
 * @param {string[]} urls
 * @param {string} query
 * @param {{maxChars?: number, timeoutMs?: number, signal?: AbortSignal}} opts
 */
export async function readMany(urls, query, opts = {}) {
  const started = Date.now();
  const maxChars = Math.max(200, Math.min(8000, opts.maxChars ?? 2000));
  const timeoutMs = opts.timeoutMs ?? 8000;
  const terms = queryTerms(query);

  const one = async (url) => {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('超时')), timeoutMs);
    const onAbort = () => ctrl.abort(new Error('已取消'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': UA },
      });
      if (!res.ok) {
        return { url, ok: false, reason: `HTTP ${res.status}`, ms: Date.now() - t0 };
      }
      const type = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      if (!type.includes('html') && !type.includes('xml') && !type.includes('text/plain')) {
        return { url, ok: false, reason: `不是网页（Content-Type=${type.split(';')[0]}）`, ms: Date.now() - t0 };
      }
      const { text, title, chars } = extractText(raw);
      if (chars < 200) {
        return {
          url, ok: false, title, chars,
          reason: `正文只有 ${chars} 字（多半是 SPA 空壳或需要登录）`,
          ms: Date.now() - t0,
        };
      }
      const picked = pickRelevant(text, terms, { maxChars, top: 3 });
      const hits = picked.reduce((a, p) => a + p.hits, 0);
      // 抽出来一大坨但一个关键词都没命中：多半是导航/评论，别当正文端上去
      if (terms.length > 0 && hits === 0) {
        return {
          url, ok: false, title, chars,
          reason: `抽出 ${chars} 字但没命中任何关键词（可能是导航页或内容不在正文里）`,
          ms: Date.now() - t0,
        };
      }
      return {
        url, ok: true, title, chars,
        snippets: picked.map((p) => p.text),
        hits,
        ms: Date.now() - t0,
      };
    } catch (error) {
      const reason = ctrl.signal.aborted
        ? (opts.signal?.aborted ? '已取消' : `超过 ${timeoutMs}ms`)
        : String(error?.cause?.code || error?.message || error);
      return { url, ok: false, reason, ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  };

  const results = await Promise.all(urls.map((u) => one(u)));
  return { pages: results, totalMs: Date.now() - started, terms };
}

export { formatSource };
