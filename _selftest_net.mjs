/* dsh-search-enhance 联网自检：真打网络，验证四个工具端到端可用。
   跑法：node _selftest_net.mjs
   注意：本机连不上的站（维基百科等）会被如实记为失败，不算测试失败。 */
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { registerTools } = await import(pathToFileURL(path.join(here, 'lib', 'tools.js')).href);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`); }
};
const textOf = (r) => (r && typeof r === 'object' && typeof r.text === 'string') ? r.text : String(r);

const registered = new Map();
const ctx = { tools: { register(def) { registered.set(def.name, def); return { dispose() {} }; } } };
const handle = registerTools(ctx, {
  cacheFile: path.join(os.tmpdir(), `sec-net-cache-${process.pid}.json`),
  memoryFile: path.join(os.tmpdir(), `sec-net-sites-${process.pid}.json`),
});
const call = async (name, args) => textOf(await registered.get(name).execute(args, {}));

console.log('[单查询]');
const q = '混合专家 MoE 路由 原理';
let t0 = Date.now();
const out1 = await call('dsh_search_many', { queries: [q] });
const ms1 = Date.now() - t0;
ok('有结果', /^\d+\.\s+http/m.test(out1) || /https?:\/\//.test(out1), out1.slice(0, 300));
ok('走的是中文默认后端', /后端：.*(360|Bing)/.test(out1), out1.slice(-160));
ok('耗时 < 6000ms', ms1 < 6000, `${ms1}ms`);
console.log(`    单查询 ${ms1}ms`);

console.log('\n[缓存]');
t0 = Date.now();
const out2 = await call('dsh_search_many', { queries: [q] });
const ms2 = Date.now() - t0;
ok('第二次快很多', ms2 < 200, `${ms2}ms`);
ok('报告缓存命中', /缓存命中 1/.test(out2), out2.slice(-160));
console.log(`    缓存后 ${ms2}ms`);

console.log('\n[多查询并发]');
t0 = Date.now();
const out3 = await call('dsh_search_many', { queries: ['MoE 负载均衡 策略', '专家并行 显存', 'MoE 路由 损失'] });
const ms3 = Date.now() - t0;
ok('三个查询都有段落', (out3.match(/^\d+\.\s+/gm) || []).length >= 3, out3.slice(0, 300));
ok('耗时远小于串行', ms3 < 6000, `${ms3}ms`);
const out3full = out3;
ok('尾部有后端统计', /后端：360 \d+\/\d+/.test(out3full), out3full.slice(-200));
console.log(`    三并发 ${ms3}ms`);

console.log('\n[arXiv 英文]');
t0 = Date.now();
const out4 = await call('dsh_search_many', { queries: ['mixture of experts routing'], backends: ['arxiv'] });
const ms4 = Date.now() - t0;
ok('arXiv 有结果或明确报错', /arxiv\.org/.test(out4) || /失败/.test(out4), out4.slice(0, 300));
console.log(`    arXiv ${ms4}ms`);

console.log('\n[批量读正文]');
const urls = [
  'https://www.runoob.com/css3/css3-flexbox.html',
  'https://www.ruanyifeng.com/blog/2015/07/flex-grammar.html',
  'https://developer.mozilla.org/zh-CN/docs/Web/CSS/CSS_flexible_box_layout/Basic_concepts_of_flexbox',
];
t0 = Date.now();
const out5 = await call('dsh_search_read', { urls, query: 'flex 弹性布局' });
const ms5 = Date.now() - t0;
ok('读到正文', out5.length > 500, `${out5.length} 字符`);
ok('提到来源 URL', urls.some((u) => out5.includes(new URL(u).hostname)), out5.slice(0, 300));
ok('有正文字数统计', /\d+\s*字/.test(out5) || /\d+ 字符/.test(out5), out5.slice(-200));
ok('耗时 < 12000ms', ms5 < 12000, `${ms5}ms`);
console.log(`    批量读 ${ms5}ms，输出 ${out5.length} 字符`);

console.log('\n[本地索引]');
const root = path.join(here, 'lib');
t0 = Date.now();
const out6 = await call('dsh_search_local', { root, query: 'classifyFailure' });
const ms6 = Date.now() - t0;
ok('搜到 memory.js', out6.includes('memory.js'), out6.slice(0, 300));
console.log(`    本地搜 ${ms6}ms`);

console.log('\n[status]');
const out7 = await call('dsh_search_status', {});
ok('列出三个后端', ['bing', 'so360', 'arxiv'].every((n) => out7.includes(n)), out7.slice(0, 300));
ok('列出缓存条目', /缓存条目：\d+/.test(out7));

handle.dispose();
for (const f of [`sec-net-cache-${process.pid}.json`, `sec-net-sites-${process.pid}.json`]) {
  try { (await import('node:fs')).unlinkSync(path.join(os.tmpdir(), f)); } catch {}
}

console.log(`\n${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
