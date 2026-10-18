# dsh-search-enhance

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 加四把更快的查找工具：**多源并发检索、批量读正文、查询缓存、本地全文检索**。

不覆盖 `web_search` / `read_page` —— 它们是官方工具，继续用。这个插件只补它们慢的那几块。

---

## 为什么

官方 `web_search` 一次只走一个 provider、最多 4 个查询、结果只给 snippet、**不缓存**；`read_page` 一次一个 URL、整页原样返回。实际找资料时的问题是：

| 痛点 | 官方工具的现状 | 本插件的做法 |
| --- | --- | --- |
| 读网页太慢太啰嗦 | 一次一个 URL，导航栏/脚本/样式全回来 | 一批 URL 并发抓，剥壳后按关键词挑最相关的 3 段 |
| 一个站找不到全 | 一次一个 provider | 同一个问题并发打多个后端，结果合并去重 |
| 重复搜同一个东西 | 每次都重新等 | 6 小时查询缓存，命中后是毫秒级 |
| 中文资料搜不好 | 取决于 provider | 内置 360，中文问题自动走中文源 |
| 本地代码/文档翻得慢 | — | 建一次倒排索引，之后是内存查询 |
| 挂掉的后端每轮都在等 | 没有记忆，次次等满超时 | 记住判死的后端，下一轮 0ms 跳过 |

实测（本机）：

| 场景 | 改前 | 改后 |
| --- | --- | --- |
| 4 个角度找同一主题 | 1912ms | 1122ms（1.7×），不重复来源 9 → 12 条 |
| 同一批查询再问一遍 | 1912ms | 0ms（缓存） |
| 3 页里找关键词 | 4306ms / 388591 字符 | 1791ms / 2155 字符（**省 99% 上下文**） |
| 5 个查询里有 1 个后端挂了 | 30111ms（串行） | 6017ms 一轮；下一轮 **0ms** |
| 单查询（真网络） | — | 1.0s；三个查询并发 0.66s；批量读三页 1.8s |

单查询的 1.7× 只是锦上添花，**真正省时间的是「批量读正文」和「后端记忆」**——一个省上下文，一个把「等死站超时」变成 0。

---

## 工具

### `dsh_search_many` — 多源并发检索

```
queries: ["transformers attention", "自注意力 计算复杂度"]   ← 一次问多个角度
backends?: ["bing", "so360", "arxiv"]                       ← 可选，不给就按语言自动挑
maxResults?: 10
refresh?: false                                             ← true 跳过缓存强制重查
```

- 中文问题默认走 `360 + Bing`，英文问题默认走 `Bing + 360`。
- 结果按 URL 跨后端去重，会标注「多个源都命中」。
- 一个后端挂了不影响别的，会如实报告哪个后端失败、为什么。
- **挂掉的后端会被记住**：超时一次记 30 分钟，连不上记 6 小时，期间下一轮直接 0ms 跳过；成功一次立刻解除。地址失效（4xx/5xx）不判死——那是这个链接的问题，不是站挂了。
- 内置后端：**Bing**（英文最稳）、**360**（中文质量最好，链接自带真实地址）、**arXiv**（论文原文）。

### `dsh_search_read` — 批量读正文

```
urls: ["https://...", "https://...", "https://..."]
query: "闭包 作用域"        ← 用来挑相关段落
maxChars?: 2000
```

- 并发抓、并发抽，每个页面返回最相关的 3 段而不是整页。
- 剥掉 nav/footer/header/aside/form/script/style 等。
- 抓到 SPA 空壳（正文 < 200 字）或「抽出很多字但关键词零命中」会**判为失败并说明原因**，不假装成功。

### `dsh_search_local` — 本地全文检索

```
query: "capture"
root?: "C:/path/to/project"   ← 不给就搜当前工作目录
maxResults?: 20
contextLines?: 2
```

- 第一次搜某个 root 会建索引（内存，按 root 缓存，不落盘）。
- 跳过 `node_modules` / `.git` / `dist` 等，单文件上限 512KB。
- 中文按二元组分词，英文按词，中英混排都能命中。

### `dsh_search_status` — 看缓存和后端状态

无参数。显示缓存条目数、TTL，以及每个后端是不是被判死了、还剩多久重试。

---

## 后端记忆

一个后端挂了，如果不记住，**每轮查询都要白等一次超时**。实测：一个死站 × 五个查询，第二轮照样等满 3 秒。加上记忆后第二轮 0ms。

规则：

| 情形 | 处理 |
| --- | --- |
| 超时（`超过 Nms` / `ETIMEDOUT`） | 判死，记 30 分钟——网络抖动好站也会偶尔超时，别记太久 |
| 连不上（DNS / 连接被拒 / `fetch failed`） | 判死，记 6 小时 |
| 4xx / 5xx / 页面结构变了 | **不判死**，这是链接或页面的事，站可能是好的 |
| 成功一次 | 立刻清零、解除判死 |

存在 `~/.dsh/search-enhance/sites.json`，跨会话有效。想强制重试就删这个文件。

---

## 安装

```bash
git clone https://github.com/SHW-bit/dsh-search-enhance.git
cd dsh-search-enhance
node install.mjs --check   # 先看会改什么
node install.mjs           # 装进 desktop profile
```

然后**重启 DSH 桌面端**。插件管理界面里应该能看到 `dsh-search-enhance`，可以开关。

**不要跑 `pnpm install`。** 下面「已知限制」第一条解释了原因。

卸载：

```bash
node install.mjs --uninstall
```

---

## 已知限制

- **安装必须用真实文件拷贝，不能用 `link:` / 软链 / junction。** pnpm 对任何本地路径都会生成 junction，而 DSH 桌面端的插件市场在 junction 形态下认不出这个包——插件会装好但界面上看不见它。`install.mjs` 逐文件 `copyFileSync` 复制真文件，不要改成 `pnpm add`。
- **每次更新插件要从源码目录重跑 `node install.mjs` 并重启。** profile 里是副本，不是链接。如果 DSH 还开着，个别文件可能被占用拷不上，安装器会列出是哪几个，关掉 DSH 再跑一次即可。
- **内置后端是"本机实测能连上"的那几个，不是理论最优的那几个。** Wikipedia / DuckDuckGo / Brave / Startpage / searx 在本机 10.5 秒硬超时；百度的结果走 AI 卡片 + 加密跳转，抓不到干净的标题/链接/摘要；**搜狗已上反爬**，返回 5.4KB 验证码空壳，带 cookie 也过不去；Stack Overflow 有 Cloudflare 挑战；MDN 搜索页是前端渲染。所以都没放进默认组。换网络环境后跑一遍 `_selftest_net.mjs` 再调整 `lib/search.js` 里的 `BACKENDS`。
- **搜索页面的 HTML 结构会变。** 后端解析失败时会明确报「页面结构变了，没解析出结果」，不会返回空结果假装查过。
- **缓存文件在 `~/.dsh/search-enhance/cache.json`**，默认 TTL 6 小时、最多 300 条，每次写入立即落盘（跨会话有效）。想清空就调 `dsh_search_many({refresh: true})`，或直接删这个文件。

---

## 开发

```bash
node _selftest.mjs              # 离线单测：83 项，不联网
node _selftest_memory.mjs       # 后端记忆：22 项，不联网
node _selftest_net.mjs          # 联网实测：16 项，跑真实网络
node _verify_install_search.mjs # 装完之后的落地检查：35 项
```

`_selftest.mjs` 覆盖 cache / extract / 本地索引 / memory / 工具输出格式；`_selftest_net.mjs` 覆盖真实检索、缓存命中、并发、arXiv、批量读正文、本地检索。

---

## License

MIT © 2026 SHW-bit
