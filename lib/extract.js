/* ─────────────────────────────────────────────────────────────────────────
   dsh-search-enhance · HTML 正文抽取

   目的不是「完美还原网页」，是「把 <script>/<style>/<nav>/<footer> 丢掉，
   留下人眼看的那段话」。搜索引擎的 snippet 只有一两百字，回答一个技术
   问题往往不够，这里给到正文。

   两条路：
     1. 直接抓 HTML 自己剥标签（快、零依赖、大多数技术文档站够用）
     2. 抓回来发现是 SPA 空壳（正文 < 200 字），如实报告，不装成成功

   为什么不用 readability 之类的库：这个插件零依赖是硬要求，装包会牵动
   pnpm 和 profile 的安装形态，得不偿失。
   ───────────────────────────────────────────────────────────────────────── */

/** 这些标签连同内容一起扔掉。 */
const DROP_TAGS = [
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'template',
  'nav', 'footer', 'header', 'aside', 'form', 'button', 'select', 'input',
];

/** 遇到这些标签就断行，否则整页会粘成一行。 */
const BLOCK_TAGS = [
  'p', 'div', 'section', 'article', 'main', 'li', 'tr', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'blockquote', 'pre', 'br', 'hr', 'table', 'ul', 'ol', 'dl', 'dd', 'dt',
];

/** 常见的命名实体，不装库就手动补这些，覆盖技术文档九成以上。 */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', divide: '÷',
  deg: '°', plusmn: '±', ne: '≠', le: '≤', ge: '≥', rarr: '→', larr: '←',
  harr: '↔', infin: '∞', sum: '∑', radic: '√', frac12: '½', frac14: '¼',
};

/** 解 HTML 实体，包括 `&#123;` 和 `&#x1F600;` 两种数字形式。 */
export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named !== undefined ? named : whole;
  });
}

/**
 * 从 HTML 里抽出正文纯文本。
 *
 * @param {string} html 原始 HTML
 * @returns {{ text: string, title: string, chars: number }}
 */
export function extractText(html) {
  let body = String(html ?? '');

  // 标题单独留一份，正文里就不需要它了
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().replace(/\s+/g, ' ') : '';

  // 注释先干掉，否则里面的标签会被当成正文
  body = body.replace(/<!--[\s\S]*?-->/g, '');

  // 丢掉整块内容（贪婪匹配到对应的闭合标签）
  for (const tag of DROP_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    body = body.replace(re, ' ');
    // 自闭合或没闭合的残余标签也清掉
    body = body.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ');
  }

  // 块级标签断成换行
  for (const tag of BLOCK_TAGS) {
    body = body.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '\n');
    body = body.replace(new RegExp(`<\\/${tag}>`, 'gi'), '\n');
  }

  // 其余标签直接剥掉，但保留标签之间的文字
  body = body.replace(/<[^>]+>/g, ' ');

  body = decodeEntities(body);

  // 收尾：每行去空白、连续空行压成一个
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
    .filter((line) => line.length > 0);

  const text = lines.join('\n');
  return { text, title, chars: text.length };
}

/**
 * 按段落切块，返回适合塞进上下文的片段。
 *
 * 为什么不按字数硬切：硬切会把一句话撕成两半。这里先按空行/换行切成段，
 * 再把相邻段拼到接近 `maxChars`，保证每块结尾是完整的段落。
 *
 * @param {string} text 已经抽好的正文
 * @param {number} maxChars 每块上限
 * @returns {string[]}
 */
export function chunkText(text, maxChars = 2000) {
  if (!text) return [];
  const paras = String(text).split(/\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    // 单段就超上限：硬切成几块，否则这一段永远塞不进去
    if (p.length > maxChars) {
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      for (let i = 0; i < p.length; i += maxChars) chunks.push(p.slice(i, i + maxChars));
      continue;
    }
    if (buf.length + p.length + 1 > maxChars && buf.length > 0) {
      chunks.push(buf);
      buf = '';
    }
    buf = buf ? `${buf}\n${p}` : p;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

/**
 * 在正文里找和关键词最相关的块，按命中次数排序。
 *
 * 这是「只拿回关键段落」的核心：整页丢给模型既慢又占上下文，先按词筛一遍。
 *
 * @param {string} text 正文
 * @param {string[]} terms 关键词（已经是切好的词）
 * @param {{maxChars?: number, top?: number}} opts
 * @returns {Array<{ text: string, hits: number }>}
 */
export function pickRelevant(text, terms, { maxChars = 2000, top = 3 } = {}) {
  const words = terms.map((t) => String(t).toLowerCase()).filter((t) => t.length > 0);
  // 先切块、先留顺序副本：无命中时要按原文顺序退回去，排序后的数组不能拿来退化
  const ordered = chunkText(text, maxChars);
  if (words.length === 0) {
    return ordered.slice(0, top).map((t) => ({ text: t, hits: 0 }));
  }
  const scored = ordered.map((chunk) => {
    const low = chunk.toLowerCase();
    let hits = 0;
    for (const w of words) {
      // 用 split 数不重叠出现次数，比正则更省事也不会踩转义坑
      hits += low.split(w).length - 1;
    }
    return { text: chunk, hits };
  });
  const keep = scored.filter((s) => s.hits > 0);
  // 一个词都没命中时不要返回空——退化成按原文顺序取前几块
  if (keep.length === 0) return ordered.slice(0, top).map((t) => ({ text: t, hits: 0 }));
  keep.sort((a, b) => b.hits - a.hits);
  return keep.slice(0, top);
}

/**
 * 把一个查询串切成关键词，用来筛正文相关段落。
 *
 * 跟 `index-local.js` 的 `tokenize` 不是一回事：那边要建倒排、要二元组
 * 提高召回；这边是「已知一段正文，找最相关的那几段」，切太碎反而全是
 * 噪音（「一」「个」这种字也会命中）。所以这里只取有信息量的词：
 *   · 英文/数字/下划线：长度 ≥ 2 的整词
 *   · 中文：整段连续汉字（≥ 2 字）；较短的一段话才补二元组
 */
export function queryTerms(query) {
  const q = String(query).trim().toLowerCase();
  const terms = [];
  for (const token of q.split(/\s+/).filter(Boolean)) {
    if (/[\u4e00-\u9fa5]/.test(token)) {
      // 去掉英文和标点，只留连续汉字段
      const segs = token.match(/[\u4e00-\u9fa5]+/g) ?? [];
      for (const seg of segs) {
        const chars = [...seg];
        if (chars.length >= 2) {
          terms.push(seg);
          // 只有整体搜不到时才用得上的备选粒度：二字词再拆成二元组
          if (chars.length <= 4) {
            for (let i = 0; i + 1 < chars.length; i += 1) terms.push(chars[i] + chars[i + 1]);
          }
        }
      }
    } else if (/^[a-z0-9_$][a-z0-9_$\-.]*$/.test(token) && token.length >= 2) {
      terms.push(token);
    }
    // 纯标点当查询词没有意义，丢掉
  }
  return [...new Set(terms)];
}
