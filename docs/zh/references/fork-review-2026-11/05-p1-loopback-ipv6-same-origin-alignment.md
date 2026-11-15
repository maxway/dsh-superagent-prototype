# 05 [P1] IPv6 回环地址 `[::1]` 在运维脚本与服务端 `sameOrigin` 之间契约不一致

* **优先级**：P1（中优 — 双栈 Windows 下可能导致合法回环配置被服务端 403/启动拒绝）
* **涉及文件**：
  * `src/app/http.ts`（`sameOrigin` L88-93、`registerHttp` L429-431）
  * `scripts/dsh-superagent`（`windowsStopTarget` L1107-1112 及 URL 校验处）
  * `docs/006-deployment.md` / `docs/zh/006-deployment.md`
  * `tests/http.spec.ts`、`tests/service-script.spec.ts`

---

## 一、 问题描述与根因分析

当前仓库中，“什么算是合法的本地管理端回环地址”在脚本层与服务端 HTTP 层存在不一致：

1. **服务控制脚本显式允许 IPv6 回环 `::1` / `[::1]`**：
   * `scripts/dsh-superagent:1110`：
     ```js
     if (!['http:', 'https:'].includes(target.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
       throw new Error('The management URL must be loopback; refusing to stop.')
     }
     ```
2. **但服务端 `http.ts` 严格只认 IPv4 `127.0.0.1` 与 `localhost`**：
   * `src/app/http.ts:430`：
     ```ts
     if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
     ```
     如果 DSH Profile 将 WebServer 绑定在 `'::1'` 或 `'localhost'`，插件启动直接抛异常崩溃。
   * `src/app/http.ts:88-93`：
     ```ts
     export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number | undefined): boolean {
       if (port === undefined) return false
       const host = req.headers.host
       if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
       return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
     }
     ```
     即便监听成功，任何以 `http://[::1]:<port>` 发起的管理请求（`Host: [::1]:<port>`）都会被 `sameOrigin` 判定为非法并返回 `403 Same-origin management request required`。
3. **双栈 Windows 上的 `localhost` 附加隐患**：
   * 在 Windows 10/11 上，DNS 客户端默认优先将 `localhost` 解析到 `::1`，而服务端只绑定在 `127.0.0.1`。部分 HTTP 客户端（如 Node `fetch` / `.NET HttpClient`）具备 Happy Eyeballs 回退到 `127.0.0.1`，不同工具混用 `localhost` 与 `::1` 时容易产生排查困惑。

---

## 二、 方案对比与推荐设计

共有两个收敛方向，建议择一统一全栈契约：

### 方案 A（推荐，最小变更且兼容双栈回环）：服务端补齐 IPv6 回环 `[::1]` 支持

既然控制脚本已经支持 `[::1]`，只需在 `src/app/http.ts` 中补齐对 IPv6 回环的对称校验，保持对非回环网卡（如 `0.0.0.0`、`::`、局域网 IP）的绝对拒绝：

1. **`registerHttp` 回环主机校验（`src/app/http.ts:430`）**：
   ```ts
   const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1', '[::1]'])
   if (!LOOPBACK_BIND_HOSTS.has(ctx.webServer.host)) {
     throw new Error('Orchestrator management requires a loopback Web server')
   }
   ```
   *注：故意不允许 `'localhost'` 作为 `ctx.webServer.host`，防止畸形 `hosts` 文件将绑定扩散到非回环地址。*
2. **`sameOrigin` Host 头校验（`src/app/http.ts:88-93`）**：
   ```ts
   export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number | undefined): boolean {
     if (port === undefined) return false
     const host = req.headers.host
     if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) return false
     return req.headers['x-orchestrator-request'] === '1'
       && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
   }
   ```
### 方案 B（备选，严格仅 IPv4）：从脚本中移除 `::1`

若明确生产与测试只允许 IPv4 `127.0.0.1`，则从 `scripts/dsh-superagent` 的白名单中移除 `'::1'` / `'[::1]'`，并在报错信息中明确提示“请使用 `http://127.0.0.1:<port>`”。

---

## 三、 验证与测试计划

1. **`tests/http.spec.ts`**：
   * 验证 `Host: [::1]:<port>` + `x-orchestrator-request: 1`（无 `Origin` 或 `Origin: http://[::1]:<port>`）可通过 `sameOrigin`；
   * 验证跨源 `Origin: http://127.0.0.1:<port>` 搭配 `Host: [::1]:<port>`、或 `0.0.0.0` / 外部域名依然返回 `403`；
   * 验证 `registerHttp` 接受 `'127.0.0.1'` 与 `'::1'`，拒绝 `'0.0.0.0'` 与 `'::'`。
2. **文档同步**：更新 `docs/006-deployment.md` 与 `docs/zh/006-deployment.md` 中 Management API 的 Host 头说明。
