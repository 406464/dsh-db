/**
 * storage hub 的 SQLite 后端：填官方缺的那一格（dsh-storage 的 README 已经引用
 * storage-sqlite，但这个 build 里没有随包）。
 *
 * 契约（对齐 @deepseek-ai/dsh-storage 的 backend.ts）：
 *   backend = { kv: { open(descriptor) -> KvUnit }, close() }
 *   KvUnit  = { loadAll, putRecord, deleteRecord, backupRecord?, setGlobal, close }
 * 不 import 宿主包：StorageError / UNIT_NAME_RE 在此复刻，避免 profile 侧模块解析失败。
 * @module dsh-db/backend
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export class StorageError extends Error {
	constructor(code, message, options) {
		super(message, options)
		this.name = 'StorageError'
		this.code = code
	}
}

/** 与宿主 UNIT_NAME_RE 同形：可安全用作 SQL 标识符片段。 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/** 与宿主 storageBackendServiceKey 同形。 */
export function storageBackendServiceKey(name) {
	return `storage.backend.${name}`
}

function quoteIdent(name) {
	return `"${String(name).replace(/"/g, '""')}"`
}

function tableFor(unit, table) {
	return quoteIdent(`dsh_${unit}_${table}`)
}

class SqliteKvUnit {
	constructor(descriptor, db, metaTable, onClose) {
		this.descriptor = descriptor
		this.db = db
		this.metaTable = metaTable
		this.onClose = onClose
		this.closed = false
	}

	assertOpen() {
		if (this.closed) throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
	}

	async loadAll() {
		this.assertOpen()
		const tables = {}
		for (const table of this.descriptor.tables) {
			const rows = this.db.prepare(`SELECT key, value FROM ${tableFor(this.descriptor.name, table)}`).all()
			const records = {}
			for (const row of rows) {
				try {
					records[row.key] = JSON.parse(row.value)
				} catch (error) {
					throw new StorageError('malformed-medium', `unit '${this.descriptor.name}' table '${table}' key '${row.key}' 不是合法 JSON`, { cause: error })
				}
			}
			tables[table] = records
		}
		let globalValue = null
		if (this.descriptor.hasGlobal) {
			const row = this.db.prepare(`SELECT value FROM ${this.metaTable} WHERE singleton = 1`).get()
			if (row && row.value !== null && row.value !== undefined) {
				try {
					globalValue = JSON.parse(row.value)
				} catch (error) {
					throw new StorageError('malformed-medium', `unit '${this.descriptor.name}' global 值不是合法 JSON`, { cause: error })
				}
			}
		}
		return { tables, global: globalValue }
	}

	async putRecord(table, key, value) {
		this.assertOpen()
		this.db
			.prepare(`INSERT INTO ${tableFor(this.descriptor.name, table)} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
			.run(String(key), JSON.stringify(value))
	}

	async deleteRecord(table, key) {
		this.assertOpen()
		this.db.prepare(`DELETE FROM ${tableFor(this.descriptor.name, table)} WHERE key = ?`).run(String(key))
	}

	/** 把坏记录挪进 <table>__rejected，字节留在盘上可查。 */
	async backupRecord(table, key) {
		this.assertOpen()
		const rejected = quoteIdent(`dsh_${this.descriptor.name}_${table}__rejected`)
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS ${rejected} (key TEXT PRIMARY KEY, value TEXT, moved_at INTEGER NOT NULL)`,
		)
		const row = this.db.prepare(`SELECT value FROM ${tableFor(this.descriptor.name, table)} WHERE key = ?`).get(String(key))
		if (!row) return null
		this.db
			.prepare(`INSERT OR REPLACE INTO ${rejected} (key, value, moved_at) VALUES (?, ?, ?)`)
			.run(String(key), row.value, Date.now())
		this.db.prepare(`DELETE FROM ${tableFor(this.descriptor.name, table)} WHERE key = ?`).run(String(key))
		return `${this.path}#${rejected}#${key}`
	}

	async setGlobal(value) {
		this.assertOpen()
		if (!this.descriptor.hasGlobal) throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
		this.db
			.prepare(`INSERT INTO ${this.metaTable} (singleton, version, value) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET value = excluded.value`)
			.run(this.descriptor.version, JSON.stringify(value))
	}

	async close() {
		if (this.closed) return
		this.closed = true
		this.onClose()
	}
}

export class SqliteStorageBackend {
	constructor(root) {
		this.root = root
		this.db = null
		this.open = new Map()
		this.closed = false
	}

	async database() {
		if (this.db) return this.db
		mkdirSync(this.root, { recursive: true, mode: 0o700 })
		const { DatabaseSync } = await import('node:sqlite')
		const path = resolve(join(this.root, 'dsh-storage.db'))
		this.path = path
		const db = new DatabaseSync(path)
		db.exec('PRAGMA busy_timeout = 5000')
		db.exec('PRAGMA journal_mode = WAL')
		this.db = db
		return db
	}

	kv = {
		open: async (descriptor) => {
			if (this.closed) throw new StorageError('closed', 'sqlite backend is closed')
			if (!UNIT_NAME_RE.test(descriptor.name)) {
				throw new StorageError('malformed-medium', `invalid unit name '${descriptor.name}'`)
			}
			for (const table of descriptor.tables) {
				if (!UNIT_NAME_RE.test(table)) {
					throw new StorageError('malformed-medium', `invalid table name '${table}' in unit '${descriptor.name}'`)
				}
			}
			if (this.open.has(descriptor.name)) {
				throw new StorageError('already-open', `unit '${descriptor.name}' is already open; a unit has exactly one live handle`)
			}
			const db = await this.database()
			const metaTable = quoteIdent(`dsh_${descriptor.name}__meta`)
			db.exec(
				`CREATE TABLE IF NOT EXISTS ${metaTable} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, value TEXT)`,
			)
			for (const table of descriptor.tables) {
				db.exec(
					`CREATE TABLE IF NOT EXISTS ${tableFor(descriptor.name, table)} (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
				)
			}
			const row = db.prepare(`SELECT version FROM ${metaTable} WHERE singleton = 1`).get()
			if (row) {
				const compatible = [descriptor.version, ...(descriptor.compatibleVersions ?? [])]
				if (!compatible.includes(row.version)) {
					throw new StorageError('version-mismatch', `unit '${descriptor.name}' stored version ${row.version} is not compatible with ${descriptor.version}`)
				}
			} else {
				db.prepare(`INSERT INTO ${metaTable} (singleton, version, value) VALUES (1, ?, NULL)`).run(descriptor.version)
			}
			const onClose = () => this.open.delete(descriptor.name)
			const unit = new SqliteKvUnit(descriptor, db, metaTable, onClose)
			unit.path = this.path
			this.open.set(descriptor.name, unit)
			return unit
		},
	}

	async close() {
		if (!this.closed) this.closed = true
		for (const unit of [...this.open.values()]) await unit.close()
		if (this.db) {
			try {
				this.db.close()
			} catch {
				/* 已关闭 */
			}
			this.db = null
		}
	}
}

/**
 * 在 storage hub 上注册 `sqlite` 后端。由 index.js 通过 ctx.inject(['storage']) 软调用。
 * @returns disposer
 */
export function registerSqliteBackend(ctx, root) {
	const backend = new SqliteStorageBackend(root)
	const unregister = ctx.storage.backend.register('sqlite', backend)
	ctx.provide(storageBackendServiceKey('sqlite'), backend)
	return async () => {
		unregister()
		await backend.close()
	}
}
