/* dsh-search-enhance 离线自检：不联网，跑完就退出。
   跑法：node _selftest.mjs [插件目录] */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = process.argv[2];
const here = arg
  ? path.resolve(arg)
  : path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const load = (p) => import(pathToFileURL(path.join(here, 'lib', p)).href);

const { SearchCache, cacheKey, normalizeQuery } = await load('cache.js');
const { extractText, decodeEntities, chunkText, pickRelevant, queryTerms } = await load('extract.js');
const { TextIndex, tokenize } = await load('index-local.js');
const { BackendMemory, classifyFailure } = await load('memory.js');
const { registerTools } = await load('tools.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`); }
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
const clean = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };

/* ── cache ───────────────────────────────────────────────────── */
console.log('[cache]');
ok('normalizeQuery 压空白', normalizeQuery('  MoE   路由  ') === 'moe 路由');
ok('normalizeQuery 小写', normalizeQuery('MOE') === 'moe');
ok('cacheKey 含条数', cacheKey('moe', 10) === 'moe::10');
{
  const f = path.join(tmpDir, 'c1.json');
  const c = new SearchCache(f, { ttlMs: 1000, maxEntries: 3 });
  ok('空缓存 size=0', c.size === 0);
  ok('未命中返回 null', c.get('x') === null);
  c.set('a', [{ title: 'A' }]);
  ok('写入后 size=1', c.size === 1);
  const hit = c.get('a');
  ok('命中返回 value', Array.isArray(hit.value) && hit.value[0].title === 'A');
  ok('命中返回 ageMs', typeof hit.ageMs === 'number');
  const c2 = new SearchCache(f, { ttlMs: 1000, maxEntries: 3 });
  ok('重新读盘还命中', c2.get('a') !== null);
  ok('summary 有 key', c2.summary()[0].key === 'a');
  c2.set('b', 1); c2.set('c', 2); c2.set('d', 3);
  ok('超 maxEntries 修剪到 3', c2.size === 3, `size=${c2.size}`);
  c2.clear();
  ok('clear 后 size=0', c2.size === 0);
}
{
  const f = path.join(tmpDir, 'c2.json');
  fs.writeFileSync(f, '{broken');
  const c = new SearchCache(f, { ttlMs: 1000 });
  ok('损坏文件当空', c.size === 0);
}
{
  const f = path.join(tmpDir, 'c3.json');
  const c = new SearchCache(f, { ttlMs: 1 });
  c.set('x', 1);
  c.entries[0].at = Date.now() - 10;
  ok('过期命中返回 null', c.get('x') === null);
}

/* ── extract ─────────────────────────────────────────────────── */
console.log('[extract]');
ok('解码 &amp;', decodeEntities('a &amp; b') === 'a & b');
ok('解码 &lt;&gt;', decodeEntities('&lt;p&gt;') === '<p>');
ok('解码 &#65;', decodeEntities('&#65;') === 'A');
ok('解码 &nbsp;', decodeEntities('a&nbsp;b') === 'a b');
ok('解码中文实体', decodeEntities('&quot;引&quot;') === '"引"');
{
  const html = '<html><head><title>标题在这</title><style>.a{color:red}</style></head><body><nav>菜单</nav><p>正文第一段。</p><script>var x=1</script><p>正文第二段。</p><footer>页脚</footer></body></html>';
  const r = extractText(html);
  ok('抓到 title', r.title === '标题在这');
  ok('去掉 nav', !r.text.includes('菜单'));
  ok('去掉 footer', !r.text.includes('页脚'));
  ok('去掉 script', !r.text.includes('var x'));
  ok('去掉 style', !r.text.includes('color:red'));
  ok('保留正文', r.text.includes('正文第一段') && r.text.includes('正文第二段'));
  ok('chars 等于 text 长度', r.chars === r.text.length);
}
ok('chunkText 切块', chunkText('a'.repeat(25), 10).length === 3);
ok('chunkText 空文本', chunkText('', 10).length === 0);
ok('queryTerms 中文二元组', queryTerms('路由').includes('路由'));
ok('queryTerms 英文小写', queryTerms('MoE').includes('moe'));
ok('queryTerms 去标点', !queryTerms('!!!!').length);
ok('queryTerms 去单字符', queryTerms('a a a').length === 0);
{
  const text = '无关内容。\n路由策略讲了很多。\n又是无关。\n损失函数也很关键。\n结尾。';
  const picked = pickRelevant(text, ['路由', '损失'], { maxChars: 200, top: 2 });
  ok('pickRelevant 命中的优先', picked[0].text.includes('路由') || picked[0].text.includes('损失'));
  ok('pickRelevant 返回 hits', typeof picked[0].hits === 'number' && picked[0].hits > 0);
  const none = pickRelevant(text, ['不存在词'], { maxChars: 200, top: 2 });
  ok('无命中按原文顺序退化', none[0].text.includes('无关内容'));
}

/* ── local index ─────────────────────────────────────────────── */
console.log('[index-local]');
ok('tokenize 英文词', tokenize('const fooBar = 1').includes('fooBar'.toLowerCase()));
ok('tokenize 中文二元组', tokenize('路由策略').includes('路由'));
{
  const root = path.join(tmpDir, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/a.js'), 'function moeRouter() {\n  return "route";\n}\n');
  fs.writeFileSync(path.join(root, 'src/b.py'), 'def loss_fn():\n    return 1\n');
  fs.writeFileSync(path.join(root, 'node_modules/c.js'), 'moeRouter\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# 文档\nMoE 路由说明\n');
  const idx = new TextIndex();
  const built = idx.build(root);
  ok('跳过 node_modules', built.files === 3, `files=${built.files}`);
  ok('统计行数', built.lines >= 6, `lines=${built.lines}`);
  ok('有词条', built.terms > 0);
  const hit = idx.search('moeRouter');
  ok('搜到函数名', hit.hits.length >= 1 && hit.hits[0].file.includes('a.js'), JSON.stringify(hit.hits[0] || {}));
  ok('命中带行号', Number.isInteger(hit.hits[0].line) && hit.hits[0].line === 1);
  ok('命中带原文', typeof hit.hits[0].text === 'string' && hit.hits[0].text.includes('moeRouter'));
  const zh = idx.search('中文分词');
  ok('中文整串落空时有回退', Array.isArray(zh.hits));
  const zh2 = idx.search('路由');
  ok('中文二元组能搜到', zh2.hits.length >= 1, JSON.stringify(zh2.hits[0] || {}));
  const ctx = idx.search('route', { contextLines: 1 });
  ok('contextLines 生效', Array.isArray(ctx.hits[0].context) && ctx.hits[0].context.length > 0);
  ok('summary 有 files', idx.summary().files === 3);
}

/* ── memory ──────────────────────────────────────────────────── */
console.log('[memory]');
ok('classify 超时=down', classifyFailure('超过 6000ms') === 'down');
ok('classify HTTP=url', classifyFailure('HTTP 404') === 'url');
{
  const f = path.join(tmpDir, 'sites.json');
  const m = new BackendMemory(f);
  ok('初始未判死', m.knownDead('b') === false);
  m.markFail('b', 'UND_ERR_CONNECT_TIMEOUT');
  ok('连不上判死', m.knownDead('b') === true);
  ok('剩余 > 5h', m.deadRemainingMs('b') > 5 * 3600e3);
  m.markOk('b');
  ok('成功解死', m.knownDead('b') === false);
  m.markFail('c', 'HTTP 500');
  ok('5xx 不判死', m.knownDead('c') === false);
}

/* ── tools ───────────────────────────────────────────────────── */
console.log('[tools]');
{
  const registered = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return { dispose() {} };
      },
    },
  };
  const handle = registerTools(ctx, {
    cacheFile: path.join(tmpDir, 'tc.json'),
    memoryFile: path.join(tmpDir, 'ts.json'),
    ttlMs: 1000,
  });
  const names = registered.map((d) => d.name);
  ok('注册了 4 个工具', names.length === 4, names.join(','));
  for (const n of ['dsh_search_many', 'dsh_search_read', 'dsh_search_local', 'dsh_search_status']) {
    ok(`有 ${n}`, names.includes(n));
  }
  for (const d of registered) {
    ok(`${d.name} 名字合法`, /^[a-zA-Z0-9_-]+$/.test(d.name));
    ok(`${d.name} 有 description`, typeof d.description === 'string' && d.description.length > 5);
    ok(`${d.name} 有 parameters`, d.parameters?.type === 'object');
    ok(`${d.name} 有 output.render`, typeof d.output?.render === 'function');
    ok(`${d.name} 有 execute`, typeof d.execute === 'function');
  }
  const localDef = registered.find((d) => d.name === 'dsh_search_local');
  const root = path.join(tmpDir, 'proj');
  const r = await localDef.execute({ root, query: 'moeRouter', maxResults: 5 }, {});
  const out = r?.text ?? String(r);
  ok('local 能跑', out.includes('a.js'), out.slice(0, 200));
  const st = registered.find((d) => d.name === 'dsh_search_status');
  const stOut = st.execute({}, {});
  const stText = (stOut && typeof stOut.then === 'function') ? await stOut : stOut;
  const stv = stText?.text ?? String(stText);
  ok('status 含后端列表', ['bing', 'so360', 'arxiv'].every((n) => stv.includes(n)), stv.slice(0, 300));
  ok('status 含缓存文件', stv.includes('缓存文件'));
  handle.dispose();
  ok('dispose 不抛', true);
}

clean();
console.log(`\n${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
