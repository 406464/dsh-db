/**
 * Agent 工具面：一个 `db` 入口 + action 参数（省 context，schema 只占一份描述）。
 * 调的是 api.js 里同一份方法。
 * @module dsh-db/tools
 */
import { DbError } from './sqlite.js'

const ACTIONS = ['connections', 'add', 'create', 'remove', 'schema', 'query', 'exec', 'grid', 'export']

function jsonRender(_args, value) {
	return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

export function dbToolDef(api) {
	return {
		name: 'db',
		description:
			'DSH 数据库工作台（SQLite，node:sqlite 内置驱动）。action 取值：'
			+ 'connections=列出已登记连接；add=登记一个 .db 文件（默认关闭，需 config.allowAddConnection）；'
			+ 'create=新建一个空 SQLite 库并登记（须在允许目录下）；'
			+ 'remove=注销连接（不删文件）；schema=表/列/索引清单；query=单语句读（默认 limit 50，返回 truncated 标记）；'
			+ 'exec=写/DDL（需 config.allowWrite 且携带 confirm:true）；grid=分页浏览某表；export=把查询结果写成 CSV/JSON 文件。'
			+ '所有语句先过安全闸：禁 ATTACH/DETACH（除非 allowAttach）、禁 load_extension、未识别起始关键字拒绝。'
			+ '错误信封 {ok:false,error:{code,message}}，按 code 修正调用而不是重试。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ACTIONS, description: '要执行的操作' },
				conn: { type: 'string', description: '连接 id（来自 action=connections）。除 connections/add/create 外都必填' },
				sql: { type: 'string', description: 'SQL 文本。query 只接受单语句；exec 可多语句' },
				params: {
					type: 'array',
					items: { type: ['string', 'number', 'boolean', 'null'] },
					description: '位置参数（对应 SQL 里的 ?），按顺序绑定',
				},
				limit: { type: 'integer', minimum: 1, description: '返回行数上限；query 默认 50，grid 默认插件 defaultLimit' },
				offset: { type: 'integer', minimum: 0, description: 'grid 分页偏移' },
				table: { type: 'string', description: 'grid 的表名' },
				where: { type: 'string', description: 'grid 的原始 WHERE 片段（不含 WHERE 关键字，不允许分号）' },
				order: {
					type: 'array',
					items: {
						type: 'object',
						properties: { column: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } },
						required: ['column'],
					},
					description: 'grid 排序列',
				},
				path: { type: 'string', description: 'add 的 .db 文件绝对路径（须在允许目录内）' },
				label: { type: 'string', description: '连接显示名（可省，默认文件名）' },
				format: { type: 'string', enum: ['csv', 'json'], description: 'export 格式，默认 csv' },
				to: { type: 'string', description: 'export 目标文件路径（须在插件数据目录下）' },
				confirm: { type: 'boolean', description: 'exec 写操作确认位；必须显式传 true 才会执行' },
			},
			required: ['action'],
		},
		output: { schema: { type: 'object' }, render: jsonRender },
		timeoutMs: 30_000,
		async execute(args) {
			const a = args ?? {}
			switch (a.action) {
				case 'connections':
					return api.connectionsList()
				case 'add':
					return api.connectionsAdd({ path: a.path, label: a.label, caller: 'agent' })
				case 'create':
					return api.create({ path: a.path, label: a.label })
				case 'remove':
					return api.connectionsRemove({ id: a.conn })
				case 'schema':
					return api.schema({ conn: a.conn, includeCounts: true })
				case 'query':
					return api.agentQuery({ conn: a.conn, sql: a.sql, params: a.params, limit: a.limit })
				case 'exec':
					return api.exec({ conn: a.conn, sql: a.sql, params: a.params, confirm: a.confirm })
				case 'grid':
					return api.grid({ conn: a.conn, table: a.table, where: a.where, order: a.order, limit: a.limit, offset: a.offset })
				case 'export':
					return api.export({ conn: a.conn, sql: a.sql, params: a.params, format: a.format, limit: a.limit, to: a.to })
				default:
					throw new DbError('unknown-action', `未知 action：${String(a.action)}`)
			}
		},
	}
}
