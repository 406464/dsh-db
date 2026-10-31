/**
 * 造一个演示库（面板与工具都能立刻有东西看）。
 * 运行：node test/seed-demo.mjs   （或 DSH_DB_ROOT=自定义目录 node test/seed-demo.mjs）
 */
import { join } from 'node:path'
import { DbCore } from '../src/sqlite.js'
import { ConnectionStore } from '../src/connections.js'
import { buildApi } from '../src/api.js'
import { dataRoot } from '../src/index.js'

const root = process.env.DSH_DB_ROOT || dataRoot()

const cfg = {
	root,
	defaultLimit: 200,
	maxLimit: 5000,
	maxRows: 1000,
	maxBytes: 262144,
	agentDefaultLimit: 50,
	allowWrite: true,
	allowAttach: false,
	allowAddConnection: true,
	extraDirs: [root],
}

const core = new DbCore(cfg)
const connections = new ConnectionStore({ file: join(root, 'connections.json'), rootsProvider: () => [root] })
const api = buildApi({ core, connections, cfg })

const created = await api.create({ path: join(root, 'playground.db'), label: 'playground' })
const conn = created.connection.id

await api.exec({
	conn,
	sql: `CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`,
	confirm: true,
})
await api.exec({ conn, sql: 'DELETE FROM notes', confirm: true })
const rows = [
	['写完 dsh-db 的 README', 0, '2026-10-31'],
	['给面板加索引管理', 0, '2026-10-31'],
	['把大查询挪进 worker 线程', 1, '2026-10-31'],
]
for (const [body, done, at] of rows) {
	await api.exec({ conn, sql: 'INSERT INTO notes (body, done, created_at) VALUES (?, ?, ?)', params: [body, done, at], confirm: true })
}

const list = await api.query({ conn, sql: 'SELECT id, body, done FROM notes ORDER BY id' })
console.log('连接：', created.connection)
console.log('表内容：', JSON.stringify(list.rows, null, 2))
console.log('数据目录：', root)
core.closeAll()
