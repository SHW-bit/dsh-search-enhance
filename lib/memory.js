/* ─────────────────────────────────────────────────────────────────────────
   dsh-search-enhance · 后端记忆

   解决的问题：一个后端挂了，每次调用都要白等满超时。
   实测（`_compare_fail.mjs`）：五个查询共用一个死后端，串行 30.1s、
   一次并发也要 6.0s——而且**下一轮查询照样等 6 秒**，因为没记住它死了。

   口径与 dsh-image-fetch 的 sites.js 一致：
     · 超时一次即判死，但只记 30 分钟（网络抖动会让好站偶尔超时）
     · 连不上（DNS / 连接被拒）记 6 小时
     · 成功一次立刻清零、解除判死
     · 4xx/5xx 不判死——那是地址或页面结构的问题，不是站挂了

   落点：<DSH_HOME>/search-enhance/sites.json（和 cache.json 同目录）
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 超时判死的有效期：短，宁可半小时后重试一次 */
export const TIMEOUT_TTL_MS = 30 * 60 * 1000;
/** 连不上判死的有效期：长 */
export const DEAD_TTL_MS = 6 * 60 * 60 * 1000;

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export const DEFAULT_STORE = path.join(dshHome(), 'search-enhance', 'sites.json');

/**
 * 判断失败属于哪种：
 *   'down'    —— 站本身不可达（连不上 / 超时）。会被记住。
 *   'url'     —— 地址不对或页面结构变了（4xx/5xx/解析失败）。不记，站可能还好。
 */
export function classifyFailure(reason) {
  const r = String(reason || '');
  if (/^(?:HTTP \d{3}|页面结构变了|没解析出条目)/.test(r)) return 'url';
  if (/超时$|超过 \d+ms|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|UND_ERR_CONNECT_TIMEOUT|fetch failed/.test(r)) {
    return 'down';
  }
  return 'url';
}

export class BackendMemory {
  constructor(file = DEFAULT_STORE) {
    this.file = file;
    this.data = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.entries) return parsed;
    } catch {
      // 没有就从空开始，第一次写的时候建目录
    }
    return { version: 1, entries: {} };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // 记忆写不进去不该拖垮检索
    }
  }

  entry(backend) {
    return this.data.entries[String(backend || '')];
  }

  /** 这个后端现在是否处于「已判死」状态。按条目自己的 TTL 判断。 */
  knownDead(backend) {
    const e = this.entry(backend);
    if (!e || !e.dead) return false;
    const ttl = Number(e.ttl || DEAD_TTL_MS);
    return Date.now() - Number(e.at || 0) < ttl;
  }

  /** 还要多久才能重试（毫秒）。没判死就是 0。 */
  deadRemainingMs(backend) {
    const e = this.entry(backend);
    if (!this.knownDead(backend)) return 0;
    return Math.max(0, Number(e.ttl || DEAD_TTL_MS) - (Date.now() - Number(e.at || 0)));
  }

  /** 记一次成功：清零、解除判死。 */
  markOk(backend) {
    const b = String(backend || '');
    if (!b) return;
    this.data.entries[b] = { ok: true, dead: false, fails: 0, at: Date.now(), note: '' };
    this.save();
  }

  /**
   * 记一次失败。超时/连不上且持续到第二次，或第一次就是「连不上」，判死。
   * @param {string} backend
   * @param {string} reason 失败原因（用来决定 TTL 和是否值得记）
   * @param {{countThis?: boolean, forceDead?: boolean, ttlMs?: number}} [opts]
   */
  markFail(backend, reason = '', { countThis = true, forceDead = false, ttlMs } = {}) {
    const b = String(backend || '');
    if (!b) return { dead: false, fails: 0, remembered: false };
    if (classifyFailure(reason) === 'url') {
      // 地址或结构问题：不记，站本身可能是好的
      return { dead: false, fails: Number(this.entry(b)?.fails || 0), remembered: false };
    }
    const prev = Number(this.entry(b)?.fails || 0);
    const fails = countThis ? prev + 1 : prev;
    // 超时一次即判死（TTL 短）；连不上也立即判死（TTL 长）
    const dead = forceDead || fails >= 1;
    const ttl = ttlMs ?? (/超时|超过 \d+ms|ETIMEDOUT/.test(String(reason)) ? TIMEOUT_TTL_MS : DEAD_TTL_MS);
    this.data.entries[b] = { ok: false, dead, fails, at: Date.now(), ttl, note: String(reason).slice(0, 120) };
    this.save();
    return { dead, fails, remembered: true };
  }

  /** 活着的后端 */
  alive() {
    return Object.entries(this.data.entries).filter(([, e]) => e.ok).map(([b]) => b).sort();
  }

  /** 当前处于判死状态的后端 */
  dead() {
    return Object.entries(this.data.entries).filter(([b]) => this.knownDead(b)).map(([b]) => b).sort();
  }

  summary() {
    const rows = Object.entries(this.data.entries)
      .map(([backend, e]) => ({
        backend,
        ok: Boolean(e.ok),
        dead: this.knownDead(backend),
        fails: Number(e.fails || 0),
        remainingMs: this.deadRemainingMs(backend),
        note: String(e.note || ''),
        ageMs: Math.max(0, Date.now() - Number(e.at || 0)),
      }))
      .sort((a, b) => a.backend.localeCompare(b.backend));
    return { file: this.file, rows };
  }
}
