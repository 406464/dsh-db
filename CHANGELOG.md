# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。

## 0.1.0 - 2026-10-31

首个版本。

### Added

- **操控面板**：左侧栏「数据库」图标 → 整页工作台。连接管理、表/视图树、SQL 编辑器（Ctrl+Enter 执行）、数据网格（分页 / 点列排序 / WHERE 过滤 / 单元格编辑 / 删行）、CSV 与 JSON 导出。
- **Agent 工具** `db`：单入口 + `action` 参数（`connections` / `add` / `create` / `remove` / `schema` / `query` / `exec` / `grid` / `export`）。
- **storage hub 的 sqlite 后端**：在 `ctx.storage` 上注册名为 `sqlite` 的后端，实现 `KvFacet` / `KvUnit` 契约（含 `backupRecord`、版本兼容判定），其它插件可用 `storage-domain` 的 `routes` 把域路由到 SQLite。
- **安全闸**：只允许访问已登记的连接；路径必须落在允许根内；`ATTACH` / `DETACH` 默认禁；`load_extension` 永久拒；未识别的语句起始关键字拒；写操作需 `allowWrite` + 每次 `confirm: true`；行数与字节双上限并返回 `truncated`。
- **HTTP 面** `POST /dsh-db/api/<method>`：仅回环、仅 POST，统一 `{ok,value}` / `{ok:false,error:{code,message}}` 信封。
- 自检 `npm test`：28 组断言，覆盖语句分类、安全闸、schema、网格、写操作、导出、备份、storage 契约与调用方权限区分。

### 已知限制

- `node:sqlite` 的 `DatabaseSync` 同步执行，重查询会阻塞宿主主线程；worker 线程化在路线图上。
- 只支持 SQLite。
