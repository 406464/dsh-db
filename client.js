/**
 * dsh-db Web GUI 面板（Client 半）。
 *
 * 构建形态：DSH 的 client 模块加载器要求 `window.__ModuleLoader__.load({ id, factory })`
 * 自注册并 `return module.exports`；裸 ESM export 不会注册。本文件是手写 plain JS（不经打包器）。
 *
 * 座位：sidebar.panellist（左侧栏图标）+ main keyed（整页面板）。
 * 数据面：POST /dsh-db/api/<method>，信封 {ok,value} | {ok:false,error:{code,message}}。
 * 样式：只用 --dsw-alias-* / --dsw-specific-* token，不引宿主 UI 包。
 */
window.__ModuleLoader__.load({
	id: '@406464/dsh-db',
	factory: function (require) {
		var module = { exports: {} }
		var exports = module.exports
		var React = require('react')
		var h = React.createElement
		var useState = React.useState
		var useEffect = React.useEffect
		var useCallback = React.useCallback
		var useMemo = React.useMemo
		var useRef = React.useRef

		var NS = 'dshDb'
		var API = '/dsh-db/api'
		var PANEL_ID = 'dsh-db'

		var zh = {
			nav: '数据库',
			title: '数据库工作台',
			connections: '连接',
			addConnection: '添加连接',
			newDatabase: '新建库',
			refresh: '刷新',
			pathPlaceholder: '数据库文件绝对路径（.db / .sqlite / .sqlite3）',
			labelPlaceholder: '显示名（可省）',
			confirmAdd: '登记',
			cancel: '取消',
			remove: '注销',
			sqlTab: 'SQL',
			gridTab: '表数据',
			run: '执行',
			running: '执行中…',
			rows: '行',
			cells: '格',
			ms: '毫秒',
			truncated: '结果已截断（到达上限）',
			empty: '没有结果',
			noConnection: '还没有连接。点「添加连接」登记一个 SQLite 文件，或「新建库」创建一个。',
			tables: '表',
			views: '视图',
			rowsCount: '行数',
			filter: 'WHERE 过滤',
			filterPlaceholder: '例如 id > 10 AND name LIKE \'a%\'',
			apply: '应用',
			prev: '上一页',
			next: '下一页',
			page: '页',
			exportCsv: '导出 CSV',
			exportJson: '导出 JSON',
			readonly: '只读模式',
			writable: '可写模式',
			writeHint: '写/DDL 需在插件 config 里开 allowWrite，并在每次执行时确认',
			editCell: '改',
			save: '保存',
			discard: '放弃',
			deleteRow: '删行',
			insertRow: '插入行',
			errorPrefix: '错误',
			loading: '载入中…',
			columns: '列',
			indexes: '索引',
			limits: '上限',
			confirmWrite: '确认写入',
			noTable: '在左侧选一张表',
		}

		var en = {
			nav: 'Database',
			title: 'Database Workbench',
			connections: 'Connections',
			addConnection: 'Add connection',
			newDatabase: 'New database',
			refresh: 'Refresh',
			pathPlaceholder: 'Absolute path to a .db / .sqlite / .sqlite3 file',
			labelPlaceholder: 'Display label (optional)',
			confirmAdd: 'Register',
			cancel: 'Cancel',
			remove: 'Unregister',
			sqlTab: 'SQL',
			gridTab: 'Table data',
			run: 'Run',
			running: 'Running…',
			rows: 'rows',
			cells: 'cells',
			ms: 'ms',
			truncated: 'Result truncated at the configured limit',
			empty: 'No results',
			noConnection: 'No connections yet. Register a SQLite file or create a new database.',
			tables: 'Tables',
			views: 'Views',
			rowsCount: 'rows',
			filter: 'WHERE filter',
			filterPlaceholder: 'e.g. id > 10 AND name LIKE \'a%\'',
			apply: 'Apply',
			prev: 'Previous',
			next: 'Next',
			page: 'Page',
			exportCsv: 'Export CSV',
			exportJson: 'Export JSON',
			readonly: 'Read-only',
			writable: 'Writable',
			writeHint: 'Writes need allowWrite in the plugin config plus an explicit confirmation',
			editCell: 'Edit',
			save: 'Save',
			discard: 'Discard',
			deleteRow: 'Delete row',
			insertRow: 'Insert row',
			errorPrefix: 'Error',
			loading: 'Loading…',
			columns: 'Columns',
			indexes: 'Indexes',
			limits: 'Limits',
			confirmWrite: 'Confirm write',
			noTable: 'Pick a table on the left',
		}

		function fill(template, params) {
			if (!params) return template
			return template.replace(/\{(\w+)\}/g, function (_m, key) {
				return params[key] === undefined ? '' : String(params[key])
			})
		}

		var CSS = [
			'.dshdb-root{display:flex;flex-direction:column;height:100%;min-height:0;gap:12px;padding:16px 18px;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}',
			'.dshdb-root *{box-sizing:border-box}',
			'.dshdb-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.dshdb-title{font-size:15px;font-weight:600;margin:0}',
			'.dshdb-spacer{flex:1}',
			'.dshdb-badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
			'.dshdb-badge.on{color:var(--dsw-alias-state-success-primary)}',
			'.dshdb-badge.off{color:var(--dsw-alias-label-tertiary)}',
			'.dshdb-btn{height:28px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-button-tool-bar-fill);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}',
			'.dshdb-btn:hover{background:var(--dsw-alias-button-tool-bar-hover)}',
			'.dshdb-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}',
			'.dshdb-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}',
			'.dshdb-btn:disabled{opacity:.5;cursor:default}',
			'.dshdb-select,.dshdb-input{height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font-size:12px}',
			'.dshdb-body{display:flex;gap:12px;flex:1;min-height:0}',
			'.dshdb-side{width:230px;flex:none;display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-1);overflow:auto}',
			'.dshdb-side h4{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);font-weight:600}',
			'.dshdb-tableitem{display:flex;align-items:center;gap:6px;padding:5px 7px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
			'.dshdb-tableitem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshdb-tableitem.active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
			'.dshdb-tableitem .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dshdb-tableitem .c{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.dshdb-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
			'.dshdb-tabs{display:flex;gap:4px}',
			'.dshdb-tab{padding:4px 12px;border-radius:6px;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
			'.dshdb-tab.active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
			'.dshdb-editor{width:100%;min-height:96px;max-height:220px;resize:vertical;padding:8px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;line-height:1.5}',
			'.dshdb-gridwrap{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-base)}',
			'.dshdb-grid{border-collapse:collapse;width:100%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}',
			'.dshdb-grid th,.dshdb-grid td{border-bottom:1px solid var(--dsw-alias-border-l1);padding:5px 8px;text-align:left;white-space:nowrap;max-width:340px;overflow:hidden;text-overflow:ellipsis}',
			'.dshdb-grid th{position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-weight:600;cursor:pointer;z-index:1}',
			'.dshdb-grid td{color:var(--dsw-alias-label-primary)}',
			'.dshdb-grid td.null{color:var(--dsw-alias-label-tertiary);font-style:italic}',
			'.dshdb-grid tr:hover td{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshdb-cellinput{width:100%;height:24px;border-radius:4px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px}',
			'.dshdb-status{display:flex;align-items:center;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}',
			'.dshdb-error{padding:6px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary);font-size:12px}',
			'.dshdb-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}',
			'.dshdb-form{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
			'.dshdb-link{font-size:12px;color:var(--dsw-alias-brand-primary);text-decoration:none}',
			'.dshdb-connrow{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px}',
			'.dshdb-connrow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshdb-connrow .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dshdb-connrow .miss{color:var(--dsw-alias-state-error-primary);font-size:11px}',
		].join('\n')

		function rpc(method, payload) {
			return fetch(API + '/' + method, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload || {}),
			})
				.then(function (res) {
					return res.json().catch(function () {
						return { ok: false, error: { code: 'bad-response', message: 'HTTP ' + res.status } }
					})
				})
				.then(function (envelope) {
					if (envelope && envelope.ok) return envelope.value
					var err = new Error((envelope && envelope.error && envelope.error.message) || '未知错误')
					err.code = envelope && envelope.error && envelope.error.code
					throw err
				})
		}

		function cellText(value) {
			if (value === null || value === undefined) return 'NULL'
			if (typeof value === 'object') {
				if (value.__blob !== undefined) return '[BLOB ' + value.bytes + 'B]'
				if (value.__bigint !== undefined) return value.__bigint
				return JSON.stringify(value)
			}
			var s = String(value)
			return s.length > 200 ? s.slice(0, 200) + '…' : s
		}

		function PanelIcon(props) {
			var size = (props && props.size) || 18
			var active = !!(props && props.active)
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: active ? 2.1 : 1.7,
					opacity: active ? 1 : 0.82,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': true,
				},
				h('ellipse', { cx: 12, cy: 5.5, rx: 8, ry: 3 }),
				h('path', { d: 'M4 5.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6' }),
				h('path', { d: 'M4 11.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6' }),
			)
		}

		function makePanel(t) {
			return function DshDbPanel() {
				var _conns = useState([])
				var connections = _conns[0]
				var setConnections = _conns[1]

				var _conn = useState(null)
				var connId = _conn[0]
				var setConnId = _conn[1]

				var _info = useState(null)
				var info = _info[0]
				var setInfo = _info[1]

				var _schema = useState(null)
				var schema = _schema[0]
				var setSchema = _schema[1]

				var _tab = useState('sql')
				var tab = _tab[0]
				var setTab = _tab[1]

				var _sql = useState('SELECT name, type FROM sqlite_master WHERE type IN (\'table\',\'view\') ORDER BY name;')
				var sql = _sql[0]
				var setSql = _sql[1]

				var _result = useState(null)
				var result = _result[0]
				var setResult = _result[1]

				var _busy = useState(false)
				var busy = _busy[0]
				var setBusy = _busy[1]

				var _error = useState(null)
				var error = _error[0]
				var setError = _error[1]

				var _table = useState(null)
				var table = _table[0]
				var setTable = _table[1]

				var _grid = useState(null)
				var grid = _grid[0]
				var setGrid = _grid[1]

				var _where = useState('')
				var where = _where[0]
				var setWhere = _where[1]

				var _offset = useState(0)
				var offset = _offset[0]
				var setOffset = _offset[1]

				var _order = useState([])
				var order = _order[0]
				var setOrder = _order[1]

				var _adding = useState(false)
				var adding = _adding[0]
				var setAdding = _adding[1]

				var _draft = useState({ path: '', label: '' })
				var draft = _draft[0]
				var setDraft = _draft[1]

				var _edit = useState(null)
				var edit = _edit[0]
				var setEdit = _edit[1]

				var _download = useState(null)
				var download = _download[0]
				var setDownload = _download[1]

				var pageSize = (info && info.limits && info.limits.defaultLimit) || 200
				var conn = useMemo(function () {
					return connections.find(function (c) { return c.id === connId }) || null
				}, [connections, connId])

				var loadConnections = useCallback(function () {
					return rpc('connections.list')
						.then(function (value) {
							setConnections(value.connections || [])
							if (!value.connections || !value.connections.length) {
								setConnId(null)
								setSchema(null)
								setGrid(null)
							} else if (!value.connections.some(function (c) { return c.id === connId })) {
								setConnId(value.connections[0].id)
							}
						})
						.catch(function (e) { setError(e.message) })
				}, [connId])

				useEffect(function () {
					rpc('info').then(setInfo).catch(function () {})
					loadConnections()
				}, [])

				useEffect(function () {
					if (!connId) return
					setSchema(null)
					rpc('schema', { conn: connId, includeCounts: true })
						.then(setSchema)
						.catch(function (e) { setError(e.message) })
				}, [connId])

				var runSql = useCallback(function () {
					if (!connId) return
					setBusy(true)
					setError(null)
					setDownload(null)
					rpc('query', { conn: connId, sql: sql })
						.then(function (value) { setResult(value) })
						.catch(function (e) { setError(e.message); setResult(null) })
						.then(function () { setBusy(false) })
				}, [connId, sql])

				var loadGrid = useCallback(function (name, nextOffset, nextOrder, nextWhere) {
					if (!connId || !name) return
					setBusy(true)
					setError(null)
					rpc('grid', {
						conn: connId,
						table: name,
						where: nextWhere === undefined ? where : nextWhere,
						order: nextOrder === undefined ? order : nextOrder,
						limit: pageSize,
						offset: nextOffset === undefined ? offset : nextOffset,
					})
						.then(function (value) { setGrid(value) })
						.catch(function (e) { setError(e.message); setGrid(null) })
						.then(function () { setBusy(false) })
				}, [connId, where, order, offset, pageSize])

				var pickTable = useCallback(function (name) {
					setTable(name)
					setTab('grid')
					setOffset(0)
					setOrder([])
					setWhere('')
					loadGrid(name, 0, [], '')
				}, [loadGrid])

				var sortBy = useCallback(function (column) {
					var next = order.length && order[0].column === column
						? [{ column: column, dir: order[0].dir === 'asc' ? 'desc' : 'asc' }]
						: [{ column: column, dir: 'asc' }]
					setOrder(next)
					setOffset(0)
					loadGrid(table, 0, next, where)
				}, [order, table, where, loadGrid])

				var addConnection = useCallback(function () {
					setBusy(true)
					setError(null)
					rpc('connections.add', { path: draft.path, label: draft.label, allowCreate: false })
						.then(function () { setDraft({ path: '', label: '' }); setAdding(false); return loadConnections() })
						.catch(function (e) { setError(e.message) })
						.then(function () { setBusy(false) })
				}, [draft, loadConnections])

				var createDatabase = useCallback(function () {
					if (!draft.path) return
					setBusy(true)
					setError(null)
					rpc('db.create', { path: draft.path, label: draft.label })
						.then(function () { setDraft({ path: '', label: '' }); setAdding(false); return loadConnections() })
						.catch(function (e) { setError(e.message) })
						.then(function () { setBusy(false) })
				}, [draft, loadConnections])

				var removeConnection = useCallback(function (id) {
					setError(null)
					rpc('connections.remove', { id: id })
						.then(loadConnections)
						.catch(function (e) { setError(e.message) })
				}, [loadConnections])

				var saveCell = useCallback(function (row, column, value) {
					var key = {}
					var pk = (schema && schema.tables.find(function (x) { return x.name === table })) || null
					var pkCols = pk ? pk.columns.filter(function (c) { return c.pk }).map(function (c) { return c.name }) : []
					if (pkCols.length) pkCols.forEach(function (c) { key[c] = row[c] })
					else key.rowid = row.rowid
					setBusy(true)
					setError(null)
					rpc('grid.cell', { conn: connId, table: table, key: key, column: column, value: value, confirm: true })
						.then(function () { setEdit(null); loadGrid(table) })
						.catch(function (e) { setError(e.message) })
						.then(function () { setBusy(false) })
				}, [connId, table, schema, loadGrid])

				var deleteRow = useCallback(function (row) {
					var pk = (schema && schema.tables.find(function (x) { return x.name === table })) || null
					var pkCols = pk ? pk.columns.filter(function (c) { return c.pk }).map(function (c) { return c.name }) : []
					var key = {}
					if (pkCols.length) pkCols.forEach(function (c) { key[c] = row[c] })
					else key.rowid = row.rowid
					setBusy(true)
					setError(null)
					rpc('grid.delete', { conn: connId, table: table, key: key, confirm: true })
						.then(function () { loadGrid(table) })
						.catch(function (e) { setError(e.message) })
						.then(function () { setBusy(false) })
				}, [connId, table, schema, loadGrid])

				var doExport = useCallback(function (format) {
					if (!connId) return
					setBusy(true)
					setError(null)
					var source = tab === 'sql' ? sql : ('SELECT * FROM "' + String(table || '').replace(/"/g, '""') + '"')
					rpc('export', { conn: connId, sql: source, format: format })
						.then(function (value) {
							var blob = new Blob([value.text], { type: format === 'json' ? 'application/json' : 'text/csv' })
							setDownload({ url: URL.createObjectURL(blob), name: (table || 'query') + '.' + (format === 'json' ? 'json' : 'csv') })
						})
						.catch(function (e) { setError(e.message) })
						.then(function () { setBusy(false) })
				}, [connId, tab, sql, table, grid])

				var editorRef = useRef(null)
				// 导出用的 objectURL 随下载态更替释放，别攒着
				useEffect(function () {
					return function () {
						if (download && download.url) URL.revokeObjectURL(download.url)
					}
				}, [download])
				useEffect(function () {
					var node = editorRef.current
					if (!node) return
					var onKey = function (event) {
						if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
							event.preventDefault()
							runSql()
						}
					}
					node.addEventListener('keydown', onKey)
					return function () { node.removeEventListener('keydown', onKey) }
				}, [runSql])

				var tables = (schema && schema.tables.filter(function (x) { return x.type === 'table' })) || []
				var views = (schema && schema.tables.filter(function (x) { return x.type === 'view' })) || []

				return h('div', { className: 'dshdb-root' },
					h('style', null, CSS),

					// ── 顶栏 ──
					h('div', { className: 'dshdb-bar' },
						h('h2', { className: 'dshdb-title' }, t('title')),
						h('select', {
							className: 'dshdb-select',
							value: connId || '',
							onChange: function (e) { setConnId(e.target.value); setTable(null); setGrid(null); setResult(null) },
						}, connections.length
							? connections.map(function (c) {
								return h('option', { key: c.id, value: c.id }, (c.exists ? '' : '! ') + (c.label || c.id))
							})
							: h('option', { value: '' }, t('noConnection'))),
						h('button', { className: 'dshdb-btn', onClick: function () { setAdding(true) } }, t('addConnection')),
						h('button', { className: 'dshdb-btn', onClick: loadConnections }, t('refresh')),
						h('div', { className: 'dshdb-spacer' }),
						info
							? h('span', {
								className: 'dshdb-badge ' + (info.policy.allowWrite ? 'on' : 'off'),
								title: t('writeHint'),
							}, info.policy.allowWrite ? t('writable') : t('readonly'))
							: null,
						info ? h('span', { className: 'dshdb-badge' }, t('limits') + ' ' + info.limits.defaultLimit + ' / ' + info.limits.maxRows) : null,
					),

					// ── 添加连接表单 ──
					adding
						? h('div', { className: 'dshdb-form' },
							h('input', {
								className: 'dshdb-input',
								style: { flex: '1 1 340px' },
								placeholder: t('pathPlaceholder'),
								value: draft.path,
								onChange: function (e) { setDraft({ path: e.target.value, label: draft.label }) },
							}),
							h('input', {
								className: 'dshdb-input',
								style: { width: 160 },
								placeholder: t('labelPlaceholder'),
								value: draft.label,
								onChange: function (e) { setDraft({ path: draft.path, label: e.target.value }) },
							}),
							h('button', { className: 'dshdb-btn primary', disabled: busy || !draft.path, onClick: addConnection }, t('confirmAdd')),
							h('button', { className: 'dshdb-btn', disabled: busy || !draft.path, onClick: createDatabase }, t('newDatabase')),
							h('button', { className: 'dshdb-btn', onClick: function () { setAdding(false) } }, t('cancel')),
						)
						: null,

					error ? h('div', { className: 'dshdb-error' }, t('errorPrefix') + '：' + error) : null,

					// ── 主体 ──
					h('div', { className: 'dshdb-body' },
						h('div', { className: 'dshdb-side' },
							h('h4', null, t('tables') + (tables.length ? ' (' + tables.length + ')' : '')),
							tables.length
								? tables.map(function (x) {
									return h('div', {
										key: x.name,
										className: 'dshdb-tableitem' + (table === x.name ? ' active' : ''),
										onClick: function () { pickTable(x.name) },
									},
										h('span', { className: 'n' }, x.name),
										h('span', { className: 'c' }, x.rows === null || x.rows === undefined ? '' : String(x.rows)))
								})
								: h('div', { className: 'dshdb-empty' }, connId ? t('loading') : t('noConnection')),
							views.length
								? [h('h4', { key: 'vh' }, t('views'))].concat(views.map(function (x) {
									return h('div', {
										key: x.name,
										className: 'dshdb-tableitem' + (table === x.name ? ' active' : ''),
										onClick: function () { pickTable(x.name) },
									}, h('span', { className: 'n' }, x.name))
								}))
								: null,
							connections.length > 1
								? h('div', { style: { marginTop: 10 } },
									h('h4', null, t('connections')),
									connections.map(function (c) {
										return h('div', { key: c.id, className: 'dshdb-connrow' },
											h('span', { className: 'n', title: c.path }, c.label || c.id),
											c.exists ? null : h('span', { className: 'miss' }, 'missing'),
											h('button', {
												className: 'dshdb-btn',
												style: { height: 22, padding: '0 6px' },
												onClick: function () { removeConnection(c.id) },
											}, t('remove')))
									}))
								: null,
						),

						h('div', { className: 'dshdb-main' },
							h('div', { className: 'dshdb-tabs' },
								h('div', { className: 'dshdb-tab' + (tab === 'sql' ? ' active' : ''), onClick: function () { setTab('sql') } }, t('sqlTab')),
								h('div', { className: 'dshdb-tab' + (tab === 'grid' ? ' active' : ''), onClick: function () { setTab('grid') } }, t('gridTab'))),

							tab === 'sql'
								? h('textarea', {
									ref: editorRef,
									className: 'dshdb-editor',
									value: sql,
									spellCheck: false,
									onChange: function (e) { setSql(e.target.value) },
								})
								: h('div', { className: 'dshdb-form' },
									h('span', { style: { fontWeight: 600 } }, table || t('noTable')),
									h('input', {
										className: 'dshdb-input',
										style: { flex: '1 1 260px' },
										placeholder: t('filterPlaceholder'),
										value: where,
										onChange: function (e) { setWhere(e.target.value) },
									}),
									h('button', {
										className: 'dshdb-btn',
										onClick: function () { setOffset(0); loadGrid(table, 0, order, where) },
									}, t('apply'))),

							h('div', { className: 'dshdb-bar' },
								h('button', {
									className: 'dshdb-btn primary',
									disabled: busy || !connId || (tab === 'grid' && !table),
									onClick: function () { tab === 'sql' ? runSql() : loadGrid(table) },
								}, busy ? t('running') : t('run')),
								h('button', { className: 'dshdb-btn', disabled: busy || !connId, onClick: function () { doExport('csv') } }, t('exportCsv')),
								h('button', { className: 'dshdb-btn', disabled: busy || !connId, onClick: function () { doExport('json') } }, t('exportJson')),
								download
									? h('a', { className: 'dshdb-link', href: download.url, download: download.name }, '↓ ' + download.name)
									: null,
								tab === 'grid' && grid
									? h(React.Fragment, { key: 'pager' },
										h('div', { className: 'dshdb-spacer' }),
										h('div', { className: 'dshdb-form' },
											h('button', {
												className: 'dshdb-btn',
												disabled: offset <= 0,
												onClick: function () { var next = Math.max(0, offset - pageSize); setOffset(next); loadGrid(table, next) },
											}, t('prev')),
											h('span', { className: 'dshdb-status' }, t('page') + ' ' + (Math.floor(offset / pageSize) + 1)),
											h('button', {
												className: 'dshdb-btn',
												disabled: !grid.total || offset + pageSize >= grid.total,
												onClick: function () { var next = offset + pageSize; setOffset(next); loadGrid(table, next) },
											}, t('next'))))
									: null),

							h('div', { className: 'dshdb-status' },
								result && tab === 'sql'
									? [
										h('span', { key: 'r' }, result.rowCount + ' ' + t('rows')),
										h('span', { key: 't' }, result.elapsedMs + ' ' + t('ms')),
										result.truncated ? h('span', { key: 'x', style: { color: 'var(--dsw-alias-state-error-primary)' } }, t('truncated')) : null,
									]
									: grid && tab === 'grid'
										? [
											h('span', { key: 'r' }, (grid.total === null ? '?' : grid.total) + ' ' + t('rowsCount')),
											h('span', { key: 't' }, grid.elapsedMs + ' ' + t('ms')),
										]
										: null),

							h('div', { className: 'dshdb-gridwrap' },
								renderGrid(tab === 'sql' ? result : grid, {
									editable: tab === 'grid' && !!(info && info.policy.allowWrite),
									edit: edit,
									setEdit: setEdit,
									saveCell: saveCell,
									deleteRow: deleteRow,
									sortBy: sortBy,
									order: order,
									t: t,
								})),
						),
					),
				)
			}
		}

		function renderGrid(data, opts) {
			var t = opts.t
			if (!data) return h('div', { className: 'dshdb-empty' }, t('empty'))
			var columns = data.columns || []
			var rows = data.rows || []
			if (!columns.length) return h('div', { className: 'dshdb-empty' }, t('empty'))
			return h('table', { className: 'dshdb-grid' },
				h('thead', null, h('tr', null,
					columns.map(function (c) {
						var dir = opts.order && opts.order.length && opts.order[0].column === c ? opts.order[0].dir : null
						return h('th', { key: c, onClick: function () { opts.sortBy(c) }, title: c }, c + (dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''))
					}),
					opts.editable ? h('th', null, '') : null)),
				h('tbody', null, rows.map(function (row, i) {
					return h('tr', { key: i },
						columns.map(function (c) {
							var raw = row[c]
							var isEditing = opts.edit && opts.edit.row === i && opts.edit.column === c
							if (isEditing) {
								return h('td', { key: c }, h('input', {
									className: 'dshdb-cellinput',
									autoFocus: true,
									value: opts.edit.value,
									onChange: function (event) { opts.setEdit({ row: i, column: c, value: event.target.value }) },
									onKeyDown: function (event) {
										if (event.key === 'Enter') opts.saveCell(row, c, opts.edit.value)
										if (event.key === 'Escape') opts.setEdit(null)
									},
								}), h('button', {
									className: 'dshdb-btn',
									style: { height: 22, marginLeft: 4 },
									onClick: function () { opts.saveCell(row, c, opts.edit.value) },
								}, t('save')))
							}
							return h('td', {
								key: c,
								className: raw === null ? 'null' : '',
								title: cellText(raw),
								onDoubleClick: function () {
									if (!opts.editable) return
									// BLOB / 超范围整数是编码对象，按文本编辑会写坏数据：跳过
									if (raw !== null && typeof raw === 'object') return
									opts.setEdit({ row: i, column: c, value: raw === null ? '' : String(raw) })
								},
							}, cellText(raw))
						}),
						opts.editable
							? h('td', { key: '__ops' }, h('button', {
								className: 'dshdb-btn',
								style: { height: 22, padding: '0 6px' },
								onClick: function () { opts.deleteRow(row) },
							}, t('deleteRow')))
							: null)
				})))
		}

		return {
			inject: ['slots', 'locale'],
			apply: function (ctx) {
				if (ctx.locale && typeof ctx.locale.register === 'function' && typeof ctx.effect === 'function') {
					ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }) }, 'dsh-db: dictionaries')
				}
				var t = ctx.locale && typeof ctx.locale.bind === 'function'
					? ctx.locale.bind(NS)
					: function (key, params) { return fill(zh[key] || en[key] || key, params) }

				if (!ctx.slots || typeof ctx.slots.inject !== 'function') return
				var Body = makePanel(t)
				try {
					ctx.slots.inject('sidebar.panellist', function () {
						var disposeIcon = ctx.slots.register({
							name: 'sidebar.panellist',
							id: PANEL_ID,
							order: 120,
							label: function () { return t('nav') },
							locale: NS,
						}, PanelIcon)
						var disposePanel = ctx.slots.register({ name: 'main', key: PANEL_ID }, Body)
						return function () { disposePanel(); disposeIcon() }
					})
				} catch (error) {
					console.warn('[dsh-db] 宿主无左侧栏 slot，跳过面板接入：', error && error.message)
				}
			},
		}
	},
})
