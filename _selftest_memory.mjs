/* 验证后端记忆：失败 → 判死 → 下一轮 0ms 跳过 → 到期可重试 → 成功清零
   跑法：node _selftest_memory.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const mem = await import(pathToFileURL(path.join(here, 'lib', 'memory.js')).href);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  ← ${detail}` : ''}`); }
};

const tmp = path.join(os.tmpdir(), `sec-mem-${process.pid}.json`);
try { fs.unlinkSync(tmp); } catch {}

console.log('\n[classifyFailure]');
ok('超时算 down', mem.classifyFailure('超过 6000ms') === 'down');
ok('connect timeout 算 down', mem.classifyFailure('UND_ERR_CONNECT_TIMEOUT') === 'down');
ok('fetch failed 算 down', mem.classifyFailure('fetch failed') === 'down');
ok('HTTP 403 算 url 不算 down', mem.classifyFailure('HTTP 403') === 'url');
ok('页面结构变了算 url', mem.classifyFailure('页面结构变了') === 'url');
ok('空原因兜底 url', mem.classifyFailure('') === 'url');

console.log('\n[第一轮：失败判死]');
let m = new mem.BackendMemory(tmp);
ok('初始未判死', m.knownDead('dead') === false);
const r1 = m.markFail('dead', 'UND_ERR_CONNECT_TIMEOUT');
ok('markFail 返回 remembered=true', r1.remembered === true, JSON.stringify(r1));
ok('markFail 返回 dead=true', r1.dead === true);
ok('现在 knownDead=true', m.knownDead('dead') === true);
ok('deadRemainingMs ≈ 6 小时', m.deadRemainingMs('dead') > 5.9 * 3600e3, String(m.deadRemainingMs('dead')));
ok('dead() 含它', m.dead().includes('dead'));

console.log('\n[超时类只记 30 分钟]');
m.markFail('timeoutish', '超过 6000ms');
ok('超时 TTL < 31 分钟', m.deadRemainingMs('timeoutish') < 31 * 60e3, String(m.deadRemainingMs('timeoutish')));

console.log('\n[url 类不记]');
m.markFail('good', 'HTTP 404');
ok('404 不判死', m.knownDead('good') === false);

console.log('\n[跨进程：重新读盘还记得]');
const m2 = new mem.BackendMemory(tmp);
ok('新实例仍判死', m2.knownDead('dead') === true);

console.log('\n[模拟 31 分钟后可重试]');
const raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
raw.entries.dead.at = Date.now() - 31 * 60e3;
raw.entries.dead.ttl = 30 * 60e3;
fs.writeFileSync(tmp, JSON.stringify(raw));
const m3 = new mem.BackendMemory(tmp);
ok('TTL 过了就不再判死', m3.knownDead('dead') === false);

console.log('\n[成功清零]');
const m4 = new mem.BackendMemory(tmp);
m4.markOk('dead');
ok('成功解死', m4.knownDead('dead') === false);
ok('fails 归零', Number(m4.entry('dead').fails) === 0);
ok('alive() 含它', m4.alive().includes('dead'));

console.log('\n[summary]');
const s = m4.summary();
ok('summary 有 rows', Array.isArray(s.rows) && s.rows.length >= 2);
ok('summary 指向同一个文件', s.file === tmp);

console.log('\n[损坏文件不崩]');
fs.writeFileSync(tmp, '{not json');
const m5 = new mem.BackendMemory(tmp);
ok('损坏时当空处理', m5.alive().length === 0 && m5.knownDead('x') === false);

try { fs.unlinkSync(tmp); } catch {}

console.log(`\n${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
