/* 实测跨轮记忆：死后端第一轮等超时、第二轮 0ms 跳过。
   跑法：node _compare_memory.mjs */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { BACKENDS, searchMany } = await import(pathToFileURL(path.join(here, 'lib', 'search.js')).href);
const { BackendMemory } = await import(pathToFileURL(path.join(here, 'lib', 'memory.js')).href);

// 塞一个永远超时的假后端：模拟「维基百科这种连不上的站」
BACKENDS.fakeDead = {
  label: '假死站',
  kind: '测试',
  run: (_q, signal) => new Promise((_res, rej) => {
    const t = setTimeout(() => rej(new Error('超过 6000ms')), 3000);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true });
  }),
};

const store = path.join(os.tmpdir(), `sec-cmp-${process.pid}.json`);
try { fs.unlinkSync(store); } catch {}

const rounds = [
  ['混合专家 MoE 路由', 'MoE 路由 如何实现', 'MoE 负载均衡 策略'],
  ['混合专家 MoE 原理', 'MoE 路由 损失函数', '专家并行 显存'],
];

async function runRound(useMemory) {
  const memory = useMemory ? new BackendMemory(store) : null;
  const t0 = Date.now();
  const r = await searchMany(rounds[1], { backends: ['fakeDead'], maxResults: 3, memory });
  return { ms: Date.now() - t0, skipped: r.skipped.length, errors: r.errors.length };
}

console.log('=== 带后端记忆 ===');
const cold = await runRound(true);
console.log(`第 1 轮（冷）：${cold.ms}ms，跳过 ${cold.skipped} 条，失败 ${cold.errors} 条`);
const warm = await runRound(true);
console.log(`第 2 轮（热）：${warm.ms}ms，跳过 ${warm.skipped} 条，失败 ${warm.errors} 条`);

console.log('\n=== 不带记忆（改前行为）===');
const a = await runRound(false);
const b = await runRound(false);
console.log(`第 1 轮：${a.ms}ms`);
console.log(`第 2 轮：${b.ms}ms`);

const saved = b.ms - warm.ms;
console.log(`\n结论：第 2 轮 ${b.ms}ms → ${warm.ms}ms，省 ${saved}ms（${(b.ms / Math.max(1, warm.ms)).toFixed(1)}×）`);

// 记一次成功应该解死
const m = new BackendMemory(store);
console.log(`成功一次前：判死=${m.knownDead('fakeDead')}`);
m.markOk('fakeDead');
console.log(`成功一次后：判死=${m.knownDead('fakeDead')}`);

try { fs.unlinkSync(store); } catch {}
