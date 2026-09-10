# BrowserTools MCP

让 AI 编程助手真正「看见」浏览器。BrowserTools MCP 会从**你正在用的真实 Chrome 会话**——已经登录、正停留在当前页面的那一个——把控制台输出、网络请求、截图和 Lighthouse 审计流式传给任何兼容 MCP 的客户端：Cursor、Claude Code、Windsurf、Cline、Zed、Gemini CLI 等。

> **2.0 是一次重写。** 三个进程变成一个，不再有未鉴权的本地服务，凭证在离开浏览器之前就会被擦除，并且有了完整测试套件。如果从 1.x 升级，请先读 [MIGRATION.md](MIGRATION.md)——**务必升级，因为 1.2.x 存在严重漏洞。** 详见 [SECURITY.md](SECURITY.md)。

---

## 为什么不用基于 CDP 的服务器

Chrome DevTools MCP、Playwright MCP 这类工具会驱动一个**全新的自动化浏览器**。写测试时这是对的；调试你正在看的那个应用时就不对了。从 Chrome 136 起，浏览器拒绝在默认用户配置（保存登录态的那个）上开启远程调试。于是你只好先把鉴权状态重建到一个一次性 profile 里，才能开始调试。

BrowserTools 通过 DevTools 扩展挂到**你已经打开的会话**上。你保持登录、停在原来的页面，助手读到的就是你看到的。它还能给出 Lighthouse 级别的性能、无障碍和 SEO 数据，而这是那些以自动化为先的服务器做不到的。

---

## 架构

日常用法只需要两块：**一个 Node 进程**（MCP 服务，内部嵌着连接器）和 **一个 Chrome DevTools 扩展**。不再需要单独启动中间服务器。

```
MCP 客户端（Cursor / Claude Code / …）
        │  stdio，MCP JSON-RPC
        ▼
┌──────────────────────────────────────────────┐
│  @agentdeskai/browser-tools-mcp（默认单进程） │
│                                              │
│  MCP Server          ConnectorClient         │
│  · tools             · 进程内直调（常态）     │
│  · resources    ──▶  · 或 HTTP 挂到已有连接器 │
│  · prompts                                   │
│                          │                   │
│                          ▼                   │
│                   Connector                  │
│                   · Express HTTP（鉴权 API） │
│                   · WebSocket（扩展通道）    │
│                   · TelemetryStore（按标签页）│
│                   · Lighthouse（独立浏览器）  │
└──────────────────────────┬───────────────────┘
                           │ 仅 loopback
                           │ HTTP 发现 + WS 推送
                           ▼
              Chrome DevTools 扩展
              · 全部逻辑在 DevTools 页（无后台 SW）
              · debugger 或注入 console 两种采集
                           │
                           ▼
              你已经登录的真实 Chrome 会话
```

### 仓库怎么拆

这是一个 npm workspace：

| 包 / 目录 | 职责 |
| --- | --- |
| `browser-tools-mcp/` | 主包。MCP stdio 入口、连接器、Lighthouse、脱敏与截图。 |
| `browser-tools-server/` | 兼容包装：转调同一连接器二进制。多客户端共享一个浏览器会话时才需要。 |
| `chrome-extension/` | Manifest V3 DevTools 扩展。采集遥测、截图、读存储，经 WebSocket 交给连接器。 |

### 进程怎么连上浏览器

启动时 `createRuntime` 按这个顺序找遥测源：

1. `--connect` 显式指向已有连接器（需 token）。
2. 会话文件里已有存活的连接器（另一个 MCP 客户端或独立 `browser-tools-server` 先起来了）——探测 `/.identity` 签名后挂上去。
3. 自己在本机拉起嵌入式连接器，并把端口 / token 写进会话文件。这是**默认路径**，不需要额外配置。
4. 连接器起不来也不阻断 MCP 握手：工具调用会返回可读的失败原因，而不是让客户端连不上。

MCP 层通过 `ConnectorClient` 接口读数据：单进程时是 `InProcessConnectorClient`（无网络跳），共享时是 `HttpConnectorClient`。

### 扩展怎么采集

扩展**没有后台 Service Worker**。1.x 里 MV3 会频繁回收 worker，最常见的报错就是 `Receiving end does not exist`。2.0 把全部逻辑放在 DevTools 页（`devtools.js`）里——页面寿命正好等于 DevTools 窗口打开的时间。

打开 DevTools 即开始采集，不必点开 BrowserTools 面板。面板只负责设置和状态。

采集有两种模式：

- **debugger（默认）**：走 Chrome DevTools Protocol，信息更全，但 Chrome 会显示「已开始调试此浏览器」横幅。
- **inject（包装页面 console）**：无横幅；也是 Firefox 唯一能用的模式。

扩展只在 loopback 上发现连接器（先试配置地址，再扫 `3025–3035`），用约定签名确认对面是自己人，然后用 WebSocket 上报 `console-error` / `network-request`，并响应截图、刷新、读存储等请求。

### 数据怎么回到模型

1. 扩展把条目推进连接器；`TelemetryStore` **按标签页**保存，写入时脱敏（`Authorization`、`Cookie`、JWT、云密钥等变成 `[REDACTED]`）。
2. MCP 工具做关键词过滤、分页（`limit` / `offset`），结果带 `total` / `returned` / `truncated`。
3. 完整历史、HAR、大截图、完整 Lighthouse 报告不塞进工具返回值，而是以 MCP **resource**（`browser-tools://…`）暴露，工具只给 `resource_link`，由助手按需拉取。
4. 审计会**另外启动**一个 Chromium（Chrome / Edge / Brave 等），不污染你正在用的登录会话。

### 安全边界（相对 1.x）

- 连接器只绑 `127.0.0.1`，拒绝非 loopback。
- HTTP API 要带每次运行生成的 token；WebSocket 只接受浏览器扩展 Origin，网页无法冒充。
- 扩展不再扫描局域网；1.x 会扫私网并认领第一个应答的主机。
- 请求/响应头默认关闭；Cookie 是可选权限，需在面板里授予。
- 页面脚本和模拟输入默认关闭，需在 BrowserTools 面板打开 **Allow page scripts and input**。交互走 DevTools 协议，inject 采集模式下不可用。

---

## 安装

两块：一个 MCP 服务（一条命令）和一个 Chrome 扩展。

### 1. 让 MCP 客户端指向服务

```json
{
  "mcpServers": {
    "browser-tools": {
      "command": "npx",
      "args": ["-y", "@agentdeskai/browser-tools-mcp@latest"]
    }
  }
}
```

在 Windows 上，如果客户端找不到 `npx`，把 `"command"` 设为 `"cmd"`，`"args"` 设为 `["/c", "npx", "-y", "@agentdeskai/browser-tools-mcp@latest"]`。

需要 **Node 22.19 或更新**。用 `node --version` 检查；若用了 nvm 或 asdf，确保编辑器继承的是同一版本。

### 2. 加载 Chrome 扩展

1. 下载或克隆本仓库。
2. 打开 `chrome://extensions`，打开 **开发者模式**。
3. 选 **加载已解压的扩展程序**，指向 `chrome-extension` 目录。

到这里就装完了。**不用再启第二个服务器**——MCP 服务自己跑连接器。

### 3. 使用

在要检查的页面打开 Chrome DevTools（F12）。DevTools 一开就开始采集；**BrowserTools** 面板只用来改设置和看状态。然后让助手做类似「看看控制台有没有错误」或「对这个页面做一次无障碍审计」的事。

不工作？跑 `npx @agentdeskai/browser-tools-mcp --doctor`，它会准确报告缺了哪一块。

想现场看采集是否生效（适合验证新安装），用 `--verbose` 启动连接器：

```
npx @agentdeskai/browser-tools-server --verbose
```

```
· console error tab 42 Uncaught TypeError: total is not a function
· network 500 POST tab 42 https://myapp.local/api/pay (1310ms)
```

不加这个标志时，连接器只报告连接和断开，正常工作和完全没采到看起来一样。

## 工具

| 工具 | 作用 |
| --- | --- |
| `getConsoleLogs` | 控制台输出，可按关键词过滤并分页 |
| `getConsoleErrors` | 错误级别输出和未捕获异常 |
| `getNetworkLogs` | XHR/fetch 请求，含状态、耗时和正文 |
| `getNetworkErrors` | 仅失败请求和 4xx/5xx |
| `getSelectedElement` | Elements 面板里当前选中的元素 |
| `getPageInfo` | 浏览器当前所在页面 |
| `getConnectionStatus` | 扩展是否已连接，以及采集条数 |
| `listBrowserTabs` | 所有已打开 DevTools 的标签页，以及用来寻址的 id |
| `takeScreenshot` | 截图**以图片返回**，并附文件路径 |
| `refreshBrowser` | 刷新被检查的标签页 |
| `getBrowserStorage` | localStorage、sessionStorage 和 Cookie（值受开关控制） |
| `wipeLogs` | 清空已采集遥测，方便干净复现 |
| `runPageScript` | 在当前页面执行一段 JS（默认关闭，需在面板打开「Allow page scripts and input」） |
| `interactWithPage` | 模拟人工点击、输入、悬停、滚动、按键（需 debugger 采集模式，且同上开关） |
| `runAccessibilityAudit` | Lighthouse 无障碍审计 |
| `runPerformanceAudit` | Lighthouse 性能审计，含 Core Web Vitals |
| `runSEOAudit` | Lighthouse SEO 审计 |
| `runBestPracticesAudit` | Lighthouse 最佳实践审计 |

另外还带三个 prompt——`debuggerMode`、`auditMode`、`nextjsSeoAudit`——给助手一套系统工作流，而不是在每个工具列表里塞一大段静态文字。

所有工具都声明了 MCP 输出 schema，客户端拿到的是结构化数据而不是要再解析的散文；只读工具也做了标注，客户端可以安全地自动批准。

### 同时开多个标签页

每个打开了 DevTools 的标签页单独记账。遥测归到产生它的标签页，保留也按标签页，吵闹的页面挤不掉你关心的那一页的历史。

工具默认作用在**当前标签页**——你最近一次打开 DevTools 的那个。某页断开再连回来不会抢走这个位置，以前就是这个问题导致截到错误页面。每条结果都会带上它来自的 `tabId` 和 `url`，以及 `otherTabs`，看错页会立刻暴露，而不是默默错下去。要指定某一页，先调 `listBrowserTabs`，再把 `tabId` 传给任意工具；传 `allTabs: true` 则跨所有标签页读取。

### 大数据不进上下文窗口

完整历史以 MCP **resource** 暴露，而不是内联；工具用 `resource_link` 指向它们，助手只在决定要看时才去拉：

| Resource | 内容 |
| --- | --- |
| `browser-tools://console/{tabId\|all}` | 全部控制台条目，不受单次调用额度限制 |
| `browser-tools://network/{tabId\|all}` | 全部已采集请求，含正文 |
| `browser-tools://har/{tabId\|all}` | 同一份流量，HAR 1.2 格式 |
| `browser-tools://screenshot/{name}` | 先前保存的截图 |
| `browser-tools://audit/{reportId}` | 摘要背后那份完整 Lighthouse 结果 |

日志工具在读取被截断时会附上链接；网络读取总会提供 HAR；截图总会链到磁盘上的图片——太大无法内联时这是唯一查看方式。最近 20 份完整 Lighthouse 报告保存在截图目录的 `audits/` 下。

### 把响应压小

撑爆上下文窗口的通常是日志。每个读取工具都接受 `limit` 和 `offset`，日志工具还接受关键词过滤：

```
getConsoleErrors({ keywords: ["hydration"], limit: 20 })
getNetworkLogs({ urlKeywords: ["/api/"], bodyKeywords: ["quota"], limit: 10 })
```

结果按时间倒序，并始终同时返回 `total` 和 `returned`，这样助手知道自己只看到了局部。

## 隐私与安全

这个工具会捕获浏览器看到的内容，因此处理得很谨慎：

- **只绑 loopback。** 连接器监听 `127.0.0.1`，拒绝非 loopback 地址。1.x 绑的是 `0.0.0.0`，局域网里谁都能访问。
- **扩展绝不离开 loopback。** 1.x 会扫描私网段，并认领第一个用约定字符串应答的主机——共享 Wi-Fi 上的任何人都能收到你的日志和截图。那段扫描已经删掉。
- **要鉴权。** HTTP API 需要每次运行生成的 token。WebSocket 只接受浏览器扩展 Origin，你访问的网页无法冒充扩展。
- **凭证在入口处擦除**：`Authorization`、`Cookie` 等头，以及捕获字符串里出现的 JWT、云密钥、厂商 token，都会变成 `[REDACTED]`。
- **请求/响应头默认关闭**（按方向分别控制），存储值除非明确请求否则不返回。
- **Cookie 访问是可选权限**，从面板授予，扩展默认并不持有。

漏洞请按 [SECURITY.md](SECURITY.md) 报告。

## 配置

命令行标志，或对应的 `BROWSER_TOOLS_*` 环境变量：

| 标志 | 用途 |
| --- | --- |
| `--port <n>` | 连接器端口（默认 3025） |
| `--screenshot-dir <path>` | 截图写入目录 |
| `--only <a,b>` | 只暴露这些工具 |
| `--exclude <a,b>` | 隐藏这些工具 |
| `--doctor` | 检查环境后退出 |
| `--verbose` | 每捕获一条就打印 |
| `--host <addr>` | 要绑定的 loopback 地址（默认 `127.0.0.1`） |
| `--connect <url>` | 挂到别处已经在跑的连接器 |
| `--token <t>` | 配合 `--connect` 使用的鉴权 token |
| `--no-redact` | 关闭凭证擦除（不推荐） |

要让多个 MCP 客户端共享同一个浏览器会话，先用 `npx @agentdeskai/browser-tools-server` 单独启动一次连接器，之后每个客户端都会自动挂上去。

## 已知限制

- 网络采集从打开 DevTools 时开始。此前已经结束的请求不会被记录——要完整页面加载，请刷新。
- 截图受字节预算限制（`screenshotMaxBytes`，默认 3 MB）。超出时会转成 JPEG，还太大再缩小。高 DPI 上内容很密的视口截图否则可能超过 13 MB，既撑爆模型上下文，也超过较新 MCP stdio 传输的读缓冲。若仍塞不进去，就只写磁盘，工具返回路径而不内联。
- 控制台采集默认走 DevTools 协议，Chrome 会显示「已开始调试此浏览器」横幅。把面板的采集模式改成 **Wrap page console** 即可避免。
- `runPageScript` / `interactWithPage` 默认不可用。先在面板勾选 **Allow page scripts and input**；模拟点击和输入还要求采集模式是 DevTools protocol。inject 模式下脚本仍可跑，交互会明确失败。不想暴露这两条工具时用 `--exclude runPageScript,interactWithPage`。
- **Firefox 未经验证。** 扩展按跨浏览器写的——有 `browser`/`chrome` 垫片、`browser_specific_settings`，以及不需要 `chrome.debugger` 的采集模式——但从未在 Firefox 里加载过，测试套件也没有覆盖。截图尤其依赖 DevTools 协议，在那里不会工作。在有人真正跑过之前，请把 Firefox 当作不支持；无论成败，欢迎反馈。
- 审计会另启一个浏览器，最多大约一分钟。任何基于 Chromium 的浏览器都可以——Chrome、Chromium、Brave、Edge、Vivaldi、Opera 或 Arc——`--doctor` 会报告将使用哪一个。用 `CHROME_PATH` 覆盖。Arc 是尽力支持，尚未验证无头模式。

## 开发

```bash
npm install
npm run build
npm test           # 单元 + 集成，不需要浏览器
npm run test:e2e   # 真实 Chromium，并加载扩展
```

`npm test` 几秒就能跑完。端到端套件会启动带界面的 Chromium、装上扩展、驱动夹具页面，并断言整条采集链路——请先执行 `npx playwright install chromium`。

## 许可证

MIT
