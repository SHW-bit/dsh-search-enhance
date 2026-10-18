/* ─────────────────────────────────────────────────────────────────────────
   dsh-search-enhance · 插件入口（Host 半）

   零依赖、不 import 任何 @deepseek-ai/* 的值，宿主升级不会把这里弄崩。

   形态：**默认导出对象** `{ name, inject, apply }`，与 dsh-image-fetch /
   dsh-whale-widget 一致 —— 插件管理读的是这个对象来判断「包挂起来了吗」，
   只有命名导出会在那条链路上读不到。
   ───────────────────────────────────────────────────────────────────────── */

import { registerTools } from './tools.js';
import { DEFAULT_TTL_MS } from './cache.js';

const PLUGIN_NAME = 'dsh-search-enhance';

async function mountTools(ctx, config) {
  if (typeof ctx?.tools?.register !== 'function') {
    console.warn(`${PLUGIN_NAME}：宿主没有 tools.register，检索工具没挂上`);
    return;
  }
  try {
    const handle = registerTools(ctx, {
      cacheFile: config?.cacheFile,
      ttlMs: Number.isFinite(config?.ttlMs) ? Number(config.ttlMs) : DEFAULT_TTL_MS,
    });
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => handle.dispose(), `${PLUGIN_NAME}：检索工具`);
    }
  } catch (error) {
    // 挂载失败只警告，不拖垮宿主启动
    console.warn(`${PLUGIN_NAME}：检索工具没挂上。${error?.message || error}`);
  }
}

const plugin = {
  name: PLUGIN_NAME,
  inject: [],
  apply(ctx, config) {
    const opts = config && typeof config === 'object' ? config : {};
    if (typeof ctx?.inject !== 'function') {
      void mountTools(ctx, opts);
      return;
    }
    ctx.inject(['tools'], (toolCtx) => { void mountTools(toolCtx, opts); });
  },
};

export default plugin;

// 同时保留命名导出：有些宿主/工具按具名读，两套都给最省事
export const name = plugin.name;
export const inject = plugin.inject;
export const apply = plugin.apply;
