# 09 [P2] GitLab Webhook 对账未分页且非法请求 `req.resume()` 存在慢速大包占用风险

* **优先级**：P2（低优 — 涉及多 Hook 企业项目兼容性与公网/局域网暴露端口的连接防护）
* **涉及文件**：
  * `src/sources/gitlab-webhook.ts`（`startWebhookListener` L77-117、`reconcileWebhook` L136-159）
  * `tests/gitlab-webhook.spec.ts`

---

## 一、 问题描述与根因分析

### 问题 A：`reconcileWebhook` 读取项目已有 Hook 未开启分页（`src/sources/gitlab-webhook.ts:145`）

当前实现：
```ts
const hooks = await commands.glabApi(z.array(HookSchema), `${project}/hooks?per_page=100`)
```
* 当目标 GitLab 项目配置了超过 100 个项目级 Webhook（在共享企业级单仓或历史遗留自动化较多的项目中可能发生），且本服务创建的 Hook 排在第 2 页之后（同时本地 `KV.gitlab.webhook` 尚未记录 `hookId` 或因迁移重置时）：
* `hooks.find(hook => hook.url === url)` 将找不到已有同名 URL 的 Hook，导致每次对账都调用 `POST ${project}/hooks` **重复创建相同的 Webhook**。

### 问题 B：Webhook 监听器对未授权/非法路径请求无限制 `req.resume()`（`src/sources/gitlab-webhook.ts:79-95`）

当前实现：
```ts
const server = createServer((req, res) => {
  // Drain the body even for a rejected request, so a slow or large payload cannot hold the connection open.
  req.resume()
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  if (path !== options.path) { res.writeHead(404); res.end(); return }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
  const header = req.headers['x-gitlab-token']
  if (!tokenMatches(options.secret, Array.isArray(header) ? header[0] : header)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ message: 'invalid webhook token' }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end('{"ok":true}')
  options.onEvent()
})
```
* **问题所在**：`webhookBind` 默认值为 `'0.0.0.0'`（监听所有网卡）。对于 `404`、`405`、`401` 的非法请求，调用 `req.resume()` + `res.end()` 在 HTTP/1.1 Keep-Alive 默认行为下，Node.js 的 `http.Server` 为了复用底层 TCP 连接，**会继续从 socket 读取并丢弃客户端发来的全部剩余请求体，直到该请求体传完为止**！
* 如果局域网扫描器或恶意客户端发送一个 `Content-Length: 10737418240`（10GB）或慢速 Chunked 流且不带合法 `X-Gitlab-Token`，`req.resume()` 反而会让服务端持续接收并消耗带宽/文件描述符，且 `server` 未显式设置较短的 `requestTimeout` / `headersTimeout`。
* 即便对于合法的 `200` 请求，GitLab Webhook 投递体通常只有几 KB 到几 MB，超过合理上限（如 1~2 MB）也没有继续排空复用连接的必要。

---

## 二、 具体修复方案

### 1. 对账查询启用分页（`src/sources/gitlab-webhook.ts`）

检查 `Commands.glabApi` 对 `--paginate` 的支持方式（`glab api --paginate` 对 JSON 数组每页输出一个独立 JSON 数组或合并数组，需与项目中 `gitlab.ts` / `commands.ts` 现有分页读取惯例对齐）：
* 使用 `commands.glabApiPages`（或按页循环 `?per_page=100&page=N` 直至返回条数 `< 100`，设置安全页数上限如 `maxPages = 20` 防止异常无限翻页），确保超过 100 个 Hook 时也能准确命中已有 `hookId` 或 `url`。

### 2. 收紧 `startWebhookListener` 的连接超时与非法请求断连策略

1. **设置 HTTP Server 严格超时参数**：
   ```ts
   server.headersTimeout = 10_000
   server.requestTimeout = 15_000
   server.keepAliveTimeout = 5_000
   ```
2. **对拒绝请求（404 / 405 / 401）显式关闭连接并限制排空字节数**：
   * 在 `404`、`405`、`401` 响应头中加入 `'connection': 'close'`；
   * 在 `res.end(...)` 的 `finish` 回调后（若 `req.complete === false`）直接 `req.socket.destroy()`（或监听 `data` 统计字节数，一旦累计超过如 `64 * 1024` 字节立即 `req.destroy()`），这样既保证客户端能完整收到 `401/404/405` 响应报文（避免客户端报 `ECONNRESET` 丢失状态码），又彻底杜绝慢速或超大非法请求体占用连接。
3. **对合法请求（200）增加最大排空上限**：
   * 统计 `req.on('data', chunk => ...)`，若单次请求体超过 `2 * 1024 * 1024`（2MB），在响应写完后关闭该连接（`req.destroy()`），不影响已触发的 `options.onEvent()`。

---

## 三、 验证与测试计划

1. **`tests/gitlab-webhook.spec.ts`**：
   * 模拟第一页返回 100 个无关 Hook、第二页包含目标 `url` Hook，验证 `reconcileWebhook` 执行 `PUT` 更新第 2 页的既有 Hook 而非重复 `POST` 新建。
   * 验证发送 `401` 错误 Token 请求时客户端仍能正常收到 `401 {"message":"invalid webhook token"}` 响应，同时当附带超大未完结请求流时连接被及时回收，不阻塞 `listener.close()`。
