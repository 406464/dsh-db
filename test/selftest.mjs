/**
 * 自检：不依赖 DSH 宿主，直接跑核心逻辑（node:sqlite + 连接表 + 安全闸 + storage 后端）。
 * 运行：node test/selftest.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { DbCore, classify, stripSql } from '../src/sqlite.js'
import { ConnectionStore } from '../src/connections.js'
import { buildApi } from '../src/api.js'
import { SqliteStorageBackend } from '../src/backend.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-db-'))
const dbPath = join(dir, 'demo.db')

const cfg = {
	root: dir,
	defaultLimit: 200,
	maxLimit: 5000,
	maxRows: 1000,
	maxBytes: 262144,
	agentDefaultLimit: 50,
	allowWrite: true,
	allowAttach: false,
	allowAddConnection: true,
	extraDirs: [dir],
}

const core = new DbCore(cfg)
const connections = new ConnectionStore({ file: join(dir, 'connections.json'), rootsProvider: () => [dir] })
const api = buildApi({ core, connections, cfg })

let passed = 0
function ok(label) {
	passed += 1
	console.log(`  ok  ${label}`)
}

async function rejects(label, fn, code) {
	try {
		await fn()
	} catch (error) {
		assert.equal(error.code, code, `${label}: 期望 code=${code}，实际 ${error.code} / ${error.message}`)
		ok(label)
		return
	}
	throw new Error(`${label}: 应当失败但成功了`)
}

async function main() {
	console.log('dsh-db selftest')

	// ── 语句分类 ──
	assert.equal(classify('  -- c\nSELECT 1').kind, 'read')
	assert.equal(classify("INSERT INTO t VALUES ('a;b')").kind, 'write')
	assert.equal(classify('PRAGMA table_info(t)').kind, 'read')
	assert.equal(classify('PRAGMA journal_mode = WAL').kind, 'write')
	assert.equal(classify('VACUUM INTO \'x\'').kind, 'write')
	assert.equal(stripSql('SELECT \'a;b\''), "SELECT ''")
	ok('classify / stripSql')

	// ── 建库 + 登记连接 ──
	const created = await api.create({ path: dbPath, label: 'demo' })
	assert.ok(created.connection.id.startsWith('db-'))
	const connId = created.connection.id
	ok('db.create + 自动登记连接')

	assert.equal(connections.list().length, 1)
	await rejects('路径越界拒绝', () => connections.add({ path: join(tmpdir(), 'escape.db'), allowCreate: true }), 'path-out-of-scope')

	// ── DDL + 写入 ──
	await api.exec({
		conn: connId,
		sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, note TEXT)',
		confirm: true,
	})
	await api.exec({
		conn: connId,
		sql: 'INSERT INTO items (name, price, note) VALUES (?, ?, ?)',
		params: ['alpha', 1.5, null],
		confirm: true,
	})
	await api.exec({ conn: connId, sql: "INSERT INTO items (name, price) VALUES ('beta', 2.5), ('gamma', 3.5)", confirm: true })
	ok('exec DDL + 参数化插入')

	await rejects('写操作缺 confirm 拒绝', () => api.exec({ conn: connId, sql: "INSERT INTO items (name) VALUES ('x')" }), 'confirm-required')

	// ── 读 ──
	const q = await api.query({ conn: connId, sql: 'SELECT id, name, price FROM items ORDER BY id' })
	assert.deepEqual(q.columns, ['id', 'name', 'price'])
	assert.equal(q.rows.length, 3)
	assert.equal(q.rows[0].name, 'alpha')
	assert.equal(q.rows[0].note, undefined)
	assert.equal(q.truncated, false)
	ok('query 列/行/limit')

	const limited = await api.query({ conn: connId, sql: 'SELECT name FROM items ORDER BY id', limit: 2 })
	assert.equal(limited.rows.length, 2)
	assert.equal(limited.truncated, true)
	ok('query limit + truncated')

	// ── 安全闸 ──
	await rejects('ATTACH 默认拒绝', () => api.query({ conn: connId, sql: "ATTACH DATABASE 'x' AS y" }), 'forbidden-sql')
	await rejects('load_extension 拒绝', () => api.exec({ conn: connId, sql: "SELECT load_extension('a')", confirm: true }), 'forbidden-sql')
	await rejects('query 多语句拒绝', () => api.query({ conn: connId, sql: 'SELECT 1; SELECT 2' }), 'multi-statement')
	await rejects('未识别语句拒绝', () => api.query({ conn: connId, sql: 'FROBNICATE table x' }), 'forbidden-sql')
	await rejects('未知连接拒绝', () => api.query({ conn: 'db-nope', sql: 'SELECT 1' }), 'not-found')

	// ── schema ──
	const s = await api.schema({ conn: connId })
	const items = s.tables.find((x) => x.name === 'items')
	assert.ok(items)
	assert.equal(items.rows, 3)
	assert.deepEqual(items.columns.map((c) => c.name), ['id', 'name', 'price', 'note'])
	assert.equal(items.columns.find((c) => c.name === 'id').pk, true)
	ok('schema 表/列/行数/PK')

	// ── 网格 ──
	const g = await api.grid({ conn: connId, table: 'items', where: "price >= 2.5", order: [{ column: 'price', dir: 'desc' }], limit: 10 })
	assert.equal(g.total, 2)
	assert.deepEqual(g.rows.map((r) => r.name), ['gamma', 'beta'])
	ok('grid where + order + total')

	const paged = await api.grid({ conn: connId, table: 'items', limit: 2, offset: 2, order: [{ column: 'id', dir: 'asc' }] })
	assert.equal(paged.rows.length, 1)
	assert.equal(paged.rows[0].name, 'gamma')
	ok('grid 分页')

	await rejects('grid 过滤里的分号拒绝', () => api.grid({ conn: connId, table: 'items', where: '1=1; DROP TABLE items' }), 'forbidden-sql')

	// ── 单元格写 ──
	const row = (await api.grid({ conn: connId, table: 'items', where: "name = 'beta'" })).rows[0]
	await api.setCell({ conn: connId, table: 'items', key: { id: row.id }, column: 'note', value: 'edited', confirm: true })
	const after = (await api.query({ conn: connId, sql: 'SELECT note FROM items WHERE id = ?', params: [row.id] })).rows[0]
	assert.equal(after.note, 'edited')
	ok('setCell 按主键定位')

	await api.deleteRow({ conn: connId, table: 'items', key: { id: row.id }, confirm: true })
	assert.equal((await api.query({ conn: connId, sql: 'SELECT COUNT(*) AS c FROM items' })).rows[0].c, 2)
	ok('deleteRow')

	const inserted = await api.insertRow({ conn: connId, table: 'items', values: { name: 'delta', price: 9 }, confirm: true })
	assert.equal(inserted.changes, 1)
	ok('insertRow')

	// ── 导出 ──
	const csv = await api.export({ conn: connId, sql: 'SELECT name, price FROM items ORDER BY name', format: 'csv' })
	assert.ok(csv.text.startsWith('name,price'))
	assert.ok(csv.text.includes('alpha,1.5'))
	const jsonOut = await api.export({ conn: connId, sql: 'SELECT name FROM items', format: 'json' })
	assert.ok(Array.isArray(JSON.parse(jsonOut.text)))
	const fileOut = await api.export({ conn: connId, sql: 'SELECT name FROM items', format: 'csv', to: join(dir, 'out', 'items.csv') })
	assert.ok(fileOut.path.endsWith('items.csv'))
	await rejects('导出越界拒绝', () => api.export({ conn: connId, sql: 'SELECT 1', to: join(tmpdir(), 'evil.csv') }), 'path-out-of-scope')
	ok('export csv / json / 落盘')

	// ── 备份 ──
	const bk = await api.backup({ conn: connId, to: join(dir, 'backup.db') })
	assert.ok(bk.path.endsWith('backup.db'))
	ok('backup (VACUUM INTO)')

	// ── 只读策略 ──
	const roCfg = { ...cfg, allowWrite: false }
	const roCore = new DbCore(roCfg)
	const roApi = buildApi({ core: roCore, connections, cfg: roCfg })
	await rejects('allowWrite=false 时 exec 拒绝', () => roApi.exec({ conn: connId, sql: 'DROP TABLE items', confirm: true }), 'write-disabled')
	roCore.closeAll()
	ok('allowWrite 策略')

	// ── storage hub 的 sqlite 后端 ──
	const backend = new SqliteStorageBackend(dir)
	const unit = await backend.kv.open({ name: 'notes', version: 1, tables: ['entries'], hasGlobal: true })
	await unit.putRecord('entries', 'a-1', { text: 'hello' })
	await unit.putRecord('entries', 'a-2', { text: 'world' })
	await unit.setGlobal({ pinned: 'a-1' })
	let loaded = await unit.loadAll()
	assert.deepEqual(loaded.tables.entries['a-1'], { text: 'hello' })
	assert.equal(loaded.global.pinned, 'a-1')
	await unit.deleteRecord('entries', 'a-2')
	loaded = await unit.loadAll()
	assert.equal(loaded.tables.entries['a-2'], undefined)
	const moved = await unit.backupRecord('entries', 'a-1')
	assert.ok(moved)
	loaded = await unit.loadAll()
	assert.equal(loaded.tables.entries['a-1'], undefined)
	await unit.close()

	const again = await backend.kv.open({ name: 'notes', version: 1, tables: ['entries'], hasGlobal: true })
	const reloaded = await again.loadAll()
	assert.equal(reloaded.global.pinned, 'a-1')
	await again.close()
	await rejects('版本不匹配拒绝', () => backend.kv.open({ name: 'notes', version: 9, tables: ['entries'], hasGlobal: true }), 'version-mismatch')
	await rejects('非法 unit 名拒绝', () => backend.kv.open({ name: 'Bad Name', version: 1, tables: [], hasGlobal: false }), 'malformed-medium')
	await backend.close()
	ok('storage sqlite backend (KvUnit 契约)')

	core.closeAll()
	rmSync(dir, { recursive: true, force: true })
	console.log(`\n${passed} 组断言全部通过`)
}

main().catch((error) => {
	console.error('\n自检失败：', error && error.message ? error.message : error)
	process.exitCode = 1
})
