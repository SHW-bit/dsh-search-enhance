/* 验证 dsh-search-enhance 装进 desktop profile 后真的能被加载。
   跑法：node _verify_install_search.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const dest = process.env.SEARCH_ENHANCE_DEST
  || path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-search-enhance');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`); }
};

console.log(`目标：${dest}\n`);

console.log('[文件]');
ok('目录存在', fs.existsSync(dest));
for (const f of ['package.json', 'cordis.patch.yml', 'icon.png', 'README.md', 'lib/index.js', 'lib/tools.js', 'lib/search.js', 'lib/cache.js', 'lib/extract.js', 'lib/index-local.js', 'lib/memory.js']) {
  ok(`有 ${f}`, fs.existsSync(path.join(dest, f)));
}

console.log('\n[形态：必须是真实目录，不能是 junction/软链]');
{
  const st = fs.lstatSync(dest);
  ok('不是符号链接', !st.isSymbolicLink());
  ok('是普通目录', st.isDirectory());
  // Windows junction 的 reparse 位在 lstat 上体现为 isSymbolicLink()；
  // 这里再查一次 realpath 位置没跑偏
  const real = fs.realpathSync(dest);
  ok('realpath 就在 node_modules 下', real.toLowerCase().includes('node_modules'), real);
}

console.log('\n[package.json]');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
  ok('name 正确', pkg.name === 'dsh-search-enhance');
  ok('有 version', typeof pkg.version === 'string' && pkg.version.length > 0);
  ok('type 是 module', pkg.type === 'module');
  ok('main 指向 lib/index.js', pkg.main === 'lib/index.js');
  ok('有 dsh.bundle.patch', Boolean(pkg.dsh?.bundle?.patch), JSON.stringify(pkg.dsh || {}));
  ok('有 icon', typeof pkg.icon === 'string');
}

console.log('\n[cordis.patch.yml]');
{
  const yml = fs.readFileSync(path.join(dest, 'cordis.patch.yml'), 'utf8');
  ok('含 insert', /insert/.test(yml));
  ok('含 id', /id:\s*dsh-search-enhance/.test(yml), yml.slice(0, 200));
  ok('含 name', /name:\s*dsh-search-enhance/.test(yml), yml.slice(0, 200));
}

console.log('\n[profile 登记]');
{
  const profilePkg = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(profilePkg, 'utf8'));
  ok('dependencies 里有它', Boolean(pkg.dependencies?.['dsh-search-enhance']), JSON.stringify(pkg.dependencies || {}).slice(0, 300));
  const bundles = pkg.dsh?.profile?.bundles;
  ok('bundles 里有它', Array.isArray(bundles) && bundles.includes('dsh-search-enhance'), JSON.stringify(bundles || null));
}

console.log('\n[能加载]');
{
  const mod = await import(pathToFileURL(path.join(dest, 'lib/index.js')).href);
  const plugin = mod.default ?? mod;
  ok('默认导出是对象', plugin && typeof plugin === 'object');
  ok('有 name', plugin.name === 'dsh-search-enhance', String(plugin.name));
  ok('有 apply', typeof plugin.apply === 'function');
  const tools = [];
  const ctx = {
    tools: { register(def) { tools.push(def); return { dispose() {} }; } },
    inject(deps, fn) { fn({ tools: ctx.tools }); return () => {}; },
    effect(fn) { return fn?.(); },
    on() {},
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    plugin() {},
  };
  try {
    plugin.apply(ctx, {});
  } catch (e) {
    ok('apply 不抛', false, e.message);
  }
  const names = tools.map((t) => t.name);
  ok('apply 后注册了工具', tools.length > 0, names.join(','));
  ok('四个工具都在', ['dsh_search_many', 'dsh_search_read', 'dsh_search_local', 'dsh_search_status'].every((n) => names.includes(n)), names.join(','));
}

console.log('\n[源码没被截断]');
{
  const src = fs.readFileSync(path.join(dest, 'lib/memory.js'), 'utf8');
  ok('memory.js 有 BackendMemory', src.includes('export class BackendMemory'));
  const s2 = fs.readFileSync(path.join(dest, 'lib/search.js'), 'utf8');
  ok('search.js 有 so360 后端', s2.includes('so360'));
  ok('search.js 接了 memory', s2.includes('memory'));
  const s3 = fs.readFileSync(path.join(dest, 'lib/cache.js'), 'utf8');
  ok('cache.js 的 set 会落盘', /set\(key, value\)[\s\S]{0,400}this\.save\(\)/.test(s3));
}

console.log(`\n${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
