/**
 * 把 dsh-search-enhance 装进 desktop profile。
 *
 * 装法：**真实文件拷贝**，不是 link:/软链/junction。
 *   起因：曾经用 `link:` 装插件，node_modules 里得到的是 Windows Junction，
 *   DSH 桌面端别的插件全是真实目录，junction 形态在插件管理那条链路上
 *   读不到（表现：装上了但界面里看不见、开关无效）。
 *   所以这里直接把 lib/ 等文件复制进 node_modules/dsh-search-enhance。
 *
 * 干这些事：
 *   1. profile/node_modules/dsh-search-enhance ← 本目录的 lib/、package.json、
 *      cordis.patch.yml、icon.png、README.md（真副本）
 *   2. profile/package.json 的 dependencies 记来源（记录用；文件已物理就位，
 *      不靠 pnpm 解析）
 *   3. profile/package.json 的 dsh.profile.bundles 末尾加插件名
 *
 * 会先备份成 package.json.bak-<时间戳>。重复跑是幂等的。
 *
 *   node install.mjs             装
 *   node install.mjs --uninstall 卸
 *   node install.mjs --check     只看会改什么，不写盘
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PKG_NAME = 'dsh-search-enhance';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// 进 node_modules 的东西（与 package.json 的 files 对齐）
const COPY_DIRS = ['lib'];
const COPY_FILES = ['package.json', 'cordis.patch.yml', 'icon.png', 'README.md'];

const args = process.argv.slice(2);
const uninstall = args.includes('--uninstall');
const checkOnly = args.includes('--check');

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function findProfile() {
  const override = process.env.DSH_PROFILE_DIR;
  if (override) return override;
  const profiles = path.join(dshHome(), 'profiles');
  const candidates = fs.existsSync(profiles)
    ? fs.readdirSync(profiles).filter((d) => fs.existsSync(path.join(profiles, d, 'package.json')))
    : [];
  if (candidates.includes('desktop')) return path.join(profiles, 'desktop');
  if (candidates.length === 1) return path.join(profiles, candidates[0]);
  throw new Error(`找不到 profile 目录。找到的是：${candidates.join(', ') || '（空）'}。设 DSH_PROFILE_DIR 指定。`);
}

const profileDir = findProfile();
const pkgFile = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const localPkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));

pkg.dependencies ??= {};
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];

const before = JSON.stringify(pkg, null, 2);

const tgzName = `${PKG_NAME}-${localPkg.version}.tgz`;
const tgzPath = path.join(HERE, tgzName);
const spec = fs.existsSync(tgzPath)
  ? `file:${tgzPath.replace(/\\/g, '/')}`
  : `file:${HERE.replace(/\\/g, '/')}`;

if (uninstall) {
  delete pkg.dependencies[PKG_NAME];
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG_NAME);
} else {
  pkg.dependencies[PKG_NAME] = spec;
  if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) pkg.dsh.profile.bundles.push(PKG_NAME);
}

const after = JSON.stringify(pkg, null, 2);
const dest = path.join(profileDir, 'node_modules', PKG_NAME);

if (checkOnly) {
  console.log(`profile ：${profileDir}`);
  console.log(`package.json ${before === after ? '无需改动' : '会改写'}：`);
  console.log(JSON.stringify({
    dependencies: uninstall ? '(删除)' : spec,
    bundles: pkg.dsh.profile.bundles,
  }, null, 2));
  console.log(`node_modules 目标：${dest}`);
  const lst = fs.lstatSync(dest, { throwIfNoEntry: false });
  console.log(`  当前存在=${Boolean(lst)}，形态=${!lst ? '—' : lst.isSymbolicLink() ? '软链/junction（市场看不见，需重装）' : '真实目录'}`);
  process.exit(0);
}

const backup = `${pkgFile}.bak-${Date.now()}`;
fs.copyFileSync(pkgFile, backup);
fs.writeFileSync(pkgFile, after + '\n', 'utf8');

if (uninstall) {
  // 先删 junction/软链（只删链接本身，别递归穿进去），再删真目录
  if (fs.existsSync(dest)) {
    const lst = fs.lstatSync(dest);
    if (lst.isSymbolicLink()) {
      fs.rmSync(dest, { recursive: false, force: true });
    } else {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    console.log(`已移除 ${dest}`);
  }
} else {
  // 清掉可能残留的 junction / 软链，再放真副本
  if (fs.existsSync(dest)) {
    const lst = fs.lstatSync(dest);
    if (lst.isSymbolicLink()) {
      fs.rmSync(dest, { recursive: false, force: true });
      console.log('先移除了一个软链/junction');
    }
  }
  fs.mkdirSync(dest, { recursive: true });

  // 逐个文件拷，不用 cpSync：DSH 开着时会占住目录句柄，
  // cpSync 在收尾阶段会 EPIPE，而它已经拷进去的文件其实是对的，
  // 报错看起来像失败。逐文件的好处是能指出到底哪个文件被锁。
  let copied = 0;
  const locked = [];
  for (const dir of COPY_DIRS) {
    const from = path.join(HERE, dir);
    const to = path.join(dest, dir);
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const srcFile = path.join(from, name);
      if (!fs.statSync(srcFile).isFile()) continue;
      try {
        fs.copyFileSync(srcFile, path.join(to, name));
        copied++;
      } catch (e) {
        if (e.code === 'EPIPE' || e.code === 'EBUSY' || e.code === 'EPERM') locked.push(`${dir}/${name}`);
        else throw e;
      }
    }
  }
  for (const file of COPY_FILES) {
    const src = path.join(HERE, file);
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, path.join(dest, file));
      copied++;
    } catch (e) {
      if (e.code === 'EPIPE' || e.code === 'EBUSY' || e.code === 'EPERM') locked.push(file);
      else throw e;
    }
  }
  console.log(`已放入真副本：${dest}（${copied} 个文件）`);
  if (locked.length > 0) {
    console.log('');
    console.log(`⚠ 有 ${locked.length} 个文件被占用没拷上：${locked.join('、')}`);
    console.log('  原因是 DSH 还开着。关掉 DSH 再跑一次 node install.mjs 即可。');
  }
}

console.log(`${uninstall ? '卸载' : '安装'}完成：${PKG_NAME}`);
console.log(`  profile ：${profileDir}`);
console.log(`  备份    ：${path.basename(backup)}`);
console.log('');
console.log('**重启 DSH 才生效。**');
if (!uninstall) {
  console.log('');
  console.log('重启后这四个工具会出现在工具列表里：');
  console.log('  dsh_search_many    一次跑多个查询/多个后端，带 6 小时缓存');
  console.log('  dsh_search_read    批量抓网页，只回相关正文段落');
  console.log('  dsh_search_local   本地代码与文档倒排检索');
  console.log('  dsh_search_status  看缓存和索引状态');
}
