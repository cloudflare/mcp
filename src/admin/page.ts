/**
 * The dashboard page: one HTML document whose script loads `/api/summary` and
 * draws it with SVG and tables, with no dependencies.
 *
 * Tool and client names come from MCP clients, so the script only ever puts
 * data into the page with `textContent` and SVG attributes, never as HTML, and
 * the Content Security Policy allows only this page's own nonced script and style.
 */
import { DATASETS, PERIODS } from './queries'

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #f5f5f7; --card: #fff; --line: #d2d2d7; --accent: #f38020; --bad: #d93025; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #a1a1a6; --bg: #111; --card: #1c1c1e; --line: #3a3a3c; } }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; padding: 16px 24px; background: var(--card); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 1; }
header h1 { font-size: 18px; margin: 0 16px 0 0; }
header .spacer { flex: 1; }
header .meta { color: var(--muted); font-size: 12px; }
.periods button { border: 1px solid var(--line); background: transparent; color: var(--fg); padding: 6px 12px; cursor: pointer; font: inherit; }
.periods button:first-child { border-radius: 6px 0 0 6px; }
.periods button:last-child { border-radius: 0 6px 6px 0; }
.periods button + button { border-left: 0; }
.periods button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
select { font: inherit; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
main { padding: 24px; display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(480px, 1fr)); }
section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px; min-width: 0; }
section.wide { grid-column: 1 / -1; }
section h2 { font-size: 14px; margin: 0 0 4px; }
section p.note { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
.kpis { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
.kpi .value { font-size: 26px; font-weight: 600; }
.kpi .label { color: var(--muted); font-size: 12px; }
.scroll { overflow: auto; max-height: 480px; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { position: sticky; top: 0; background: var(--card); font-weight: 600; }
td.num, th.num { text-align: right; }
td.bad { color: var(--bad); }
td.heat { text-align: right; }
svg { width: 100%; height: 220px; display: block; }
svg text { fill: var(--muted); font-size: 10px; }
svg .grid { stroke: var(--line); stroke-width: 1; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; margin-top: 6px; }
.legend span::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; background: var(--swatch); vertical-align: -1px; }
.banner { grid-column: 1 / -1; background: #fdecea; color: #611a15; border: 1px solid #f5c2c0; border-radius: 10px; padding: 12px 16px; white-space: pre-wrap; }
.loading { opacity: .5; }
.empty { color: var(--muted); padding: 24px 0; text-align: center; }
`

const SCRIPT = `
'use strict'
const COLORS = ['#f38020', '#0051c3', '#2db35d', '#9b59b6', '#e5484d', '#00a3a3', '#b8860b', '#7f8c8d']
const UNKNOWN = '(unknown)'
const state = { env: document.body.dataset.env, period: document.body.dataset.period }

function el(tag, attrs, children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'text') node.textContent = value
    else if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children || []) node.append(child)
  return node
}

function svgEl(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'text') node.textContent = value
    else node.setAttribute(key, String(value))
  }
  return node
}

const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const fmtCompact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const pct = (part, whole) => (whole > 0 ? ((100 * part) / whole).toFixed(1) + '%' : '–')
const label = (value) => (value === '' || value === null || value === undefined ? UNKNOWN : String(value))
const sum = (rows, key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0)
const parseTime = (t) => new Date(String(t).replace(' ', 'T') + 'Z').getTime()

function section(title, note, wide) {
  const node = el('section', wide ? { class: 'wide' } : {}, [el('h2', { text: title })])
  if (note) node.append(el('p', { class: 'note', text: note }))
  return node
}

function table(columns, rows) {
  if (rows.length === 0) return el('div', { class: 'empty', text: 'No data for this period.' })
  const head = el('tr', {}, columns.map((c) => el('th', { class: c.num ? 'num' : '', text: c.title })))
  const body = rows.map((row) =>
    el('tr', {}, columns.map((c) =>
      el('td', { class: (c.num ? 'num ' : '') + (c.cls ? c.cls(row) : ''), text: c.value(row) })
    ))
  )
  return el('div', { class: 'scroll' }, [el('table', {}, [el('thead', {}, [head]), el('tbody', {}, body)])])
}

// series: [{ name, points: [[timeMs, value]] }]
function lineChart(series) {
  const all = series.flatMap((s) => s.points)
  if (all.length === 0) return el('div', { class: 'empty', text: 'No data for this period.' })
  const W = 800, H = 220, L = 48, R = 8, T = 8, B = 22
  const xs = all.map((p) => p[0])
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const yMax = Math.max(1, ...all.map((p) => p[1]))
  const x = (t) => L + (x1 === x0 ? (W - L - R) / 2 : ((t - x0) / (x1 - x0)) * (W - L - R))
  const y = (v) => T + (1 - v / yMax) * (H - T - B)
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', role: 'img' })
  for (let i = 0; i <= 4; i++) {
    const v = (yMax * i) / 4
    svg.append(svgEl('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }))
    svg.append(svgEl('text', { x: L - 4, y: y(v) + 3, 'text-anchor': 'end', text: fmtCompact.format(v) }))
  }
  const ticks = Math.min(6, new Set(xs).size)
  for (let i = 0; i < ticks; i++) {
    const t = ticks === 1 ? x0 : x0 + ((x1 - x0) * i) / (ticks - 1)
    const d = new Date(t)
    const text = x1 - x0 <= 2 * 86400000
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    svg.append(svgEl('text', { x: x(t), y: H - 6, 'text-anchor': 'middle', text }))
  }
  series.forEach((s, i) => {
    const points = [...s.points].sort((a, b) => a[0] - b[0])
    const d = points.map((p, j) => (j ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ')
    const path = svgEl('path', { d, fill: 'none', stroke: s.color || COLORS[i % COLORS.length], 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' })
    path.append(svgEl('title', { text: s.name }))
    svg.append(path)
  })
  const legend = el('div', { class: 'legend' }, series.map((s, i) => {
    const item = el('span', { text: s.name })
    item.style.setProperty('--swatch', s.color || COLORS[i % COLORS.length])
    return item
  }))
  return el('div', {}, [svg, legend])
}

function kpi(value, text) {
  return el('div', { class: 'kpi' }, [el('div', { class: 'value', text: value }), el('div', { class: 'label', text })])
}

function render(data) {
  const p = data.panels
  const main = document.querySelector('main')
  main.replaceChildren()

  const failed = Object.entries(data.errors)
  if (failed.length) {
    main.append(el('div', { class: 'banner', text: 'Some panels failed to load:\\n' + failed.map(([k, v]) => k + ': ' + v).join('\\n') }))
  }

  const calls = sum(p.toolTimeseries, 'calls')
  const errors = sum(p.toolTimeseries, 'errors')
  const harnessesKnown = p.harnesses.filter((r) => r.harness !== '')
  const authFailures = sum(p.authTimeseries, 'failures')
  const authTotal = authFailures + sum(p.authTimeseries, 'successes')
  const overview = section('Overview', data.periodLabel + ' · ' + data.env, true)
  overview.append(el('div', { class: 'kpis' }, [
    kpi(fmt.format(calls), 'Tool calls'),
    kpi(pct(errors, calls), 'Error rate (' + fmt.format(errors) + ')'),
    kpi(fmt.format(p.users[0] ? p.users[0].users : 0), 'Distinct users (user tokens)'),
    kpi(fmt.format(harnessesKnown.length), 'Harnesses seen'),
    kpi(pct(authFailures, authTotal), 'Sign-in failure rate'),
    kpi(fmt.format(sum(p.mismatchTimeseries, 'responses')), 'Schema-mismatch responses')
  ]))
  main.append(overview)

  const volume = section('Tool calls over time', 'Calls and error results, weighted by Analytics Engine sampling.', true)
  volume.append(lineChart([
    { name: 'Calls', points: p.toolTimeseries.map((r) => [parseTime(r.t), r.calls]) },
    { name: 'Errors', color: '#e5484d', points: p.toolTimeseries.map((r) => [parseTime(r.t), r.errors]) }
  ]))
  main.append(volume)

  const topHarnesses = p.harnesses.slice(0, 7).map((r) => r.harness)
  const byHarness = new Map(topHarnesses.map((h) => [h, []]))
  const other = []
  const otherByTime = new Map()
  for (const r of p.harnessTimeseries) {
    if (byHarness.has(r.harness)) byHarness.get(r.harness).push([parseTime(r.t), r.calls])
    else otherByTime.set(r.t, (otherByTime.get(r.t) || 0) + r.calls)
  }
  for (const [t, v] of otherByTime) other.push([parseTime(t), v])
  const harnessSeries = [...byHarness].map(([h, points]) => ({ name: label(h), points }))
  if (other.length) harnessSeries.push({ name: 'Other', points: other })
  const harnessChart = section('Calls by harness over time',
    'Harness is the 2026-07-28 clientInfo name, else the User-Agent product. ' + UNKNOWN + ' is calls recorded before client attribution shipped, or with neither.', true)
  harnessChart.append(lineChart(harnessSeries))
  main.append(harnessChart)

  const harnessTable = section('Harnesses', null)
  harnessTable.append(table([
    { title: 'Harness', value: (r) => label(r.harness) },
    { title: 'Calls', num: true, value: (r) => fmt.format(r.calls) },
    { title: 'Share', num: true, value: (r) => pct(r.calls, calls) },
    { title: 'Errors', num: true, value: (r) => fmt.format(r.errors) },
    { title: 'Error %', num: true, value: (r) => pct(r.errors, r.calls), cls: (r) => (r.calls && r.errors / r.calls > 0.2 ? 'bad' : '') }
  ], p.harnesses))
  main.append(harnessTable)

  const toolTable = section('Top tools', null)
  toolTable.append(table([
    { title: 'Tool', value: (r) => label(r.tool) },
    { title: 'Calls', num: true, value: (r) => fmt.format(r.calls) },
    { title: 'Share', num: true, value: (r) => pct(r.calls, calls) },
    { title: 'Errors', num: true, value: (r) => fmt.format(r.errors) },
    { title: 'Error %', num: true, value: (r) => pct(r.errors, r.calls), cls: (r) => (r.calls && r.errors / r.calls > 0.2 ? 'bad' : '') }
  ], p.tools))
  main.append(toolTable)

  // Harness x tool: which tools each harness calls, and how much.
  const matrixHarnesses = p.harnesses.slice(0, 8).map((r) => r.harness)
  const matrixTools = p.tools.slice(0, 30).map((r) => r.tool)
  const cells = new Map(p.harnessTools.map((r) => [r.harness + '\\u0000' + r.tool, r]))
  const maxCell = Math.max(1, ...p.harnessTools.map((r) => r.calls))
  const matrix = section('Tools by harness', 'Calls per tool (rows, top 30) and harness (columns, top 8). Hover a cell for its errors.', true)
  if (matrixTools.length === 0) {
    matrix.append(el('div', { class: 'empty', text: 'No data for this period.' }))
  } else {
    const head = el('tr', {}, [el('th', { text: 'Tool' }), ...matrixHarnesses.map((h) => el('th', { class: 'num', text: label(h) }))])
    const rows = matrixTools.map((tool) => el('tr', {}, [
      el('td', { text: label(tool) }),
      ...matrixHarnesses.map((h) => {
        const cell = cells.get(h + '\\u0000' + tool)
        const td = el('td', { class: 'heat', text: cell ? fmt.format(cell.calls) : '' })
        if (cell) {
          const alpha = (0.08 + 0.6 * Math.sqrt(cell.calls / maxCell)).toFixed(2)
          td.style.background = 'rgba(243, 128, 32, ' + alpha + ')'
          td.title = fmt.format(cell.errors) + ' errors (' + pct(cell.errors, cell.calls) + ')'
        }
        return td
      })
    ]))
    matrix.append(el('div', { class: 'scroll' }, [el('table', {}, [el('thead', {}, [head]), el('tbody', {}, rows)])]))
  }
  main.append(matrix)

  const breakdown = section('Protocol, tool mode and connection', 'Codemode is search/execute; direct is ?codemode=false. OAuth is a token this server issued; direct is a Cloudflare API token.')
  breakdown.append(table([
    { title: 'Protocol', value: (r) => label(r.protocol) },
    { title: 'Mode', value: (r) => label(r.mode) },
    { title: 'Connection', value: (r) => label(r.connection) },
    { title: 'Calls', num: true, value: (r) => fmt.format(r.calls) },
    { title: 'Share', num: true, value: (r) => pct(r.calls, calls) }
  ], p.breakdown))
  main.append(breakdown)

  const users = section('Distinct users over time', 'Users per bucket with a user token. Account tokens carry no user, and sampling makes this a lower bound.')
  users.append(lineChart([{ name: 'Users', points: p.userTimeseries.map((r) => [parseTime(r.t), r.users]) }]))
  main.append(users)

  const auth = section('Sign-ins', 'OAuth callbacks that completed or failed.')
  auth.append(lineChart([
    { name: 'Successes', color: '#2db35d', points: p.authTimeseries.map((r) => [parseTime(r.t), r.successes]) },
    { name: 'Failures', color: '#e5484d', points: p.authTimeseries.map((r) => [parseTime(r.t), r.failures]) }
  ]))
  main.append(auth)

  const authErrors = section('Top sign-in errors', null)
  authErrors.append(table([
    { title: 'Message', value: (r) => label(r.message) },
    { title: 'Failures', num: true, value: (r) => fmt.format(r.failures) }
  ], p.authErrors))
  main.append(authErrors)

  const mismatches = section('Response schema mismatches', 'Direct-tool responses that broke their OpenAPI schema, weighted by the response validation sample rate.')
  mismatches.append(lineChart([{ name: 'Responses', points: p.mismatchTimeseries.map((r) => [parseTime(r.t), r.responses]) }]))
  main.append(mismatches)

  const products = section('Mismatches by product', 'npm run report:schema-mismatches has the detail per operation.')
  products.append(table([
    { title: 'Product', value: (r) => label(r.product) },
    { title: 'Responses', num: true, value: (r) => fmt.format(r.responses) },
    { title: 'Violations', num: true, value: (r) => fmt.format(r.violations) },
    { title: 'Operations', num: true, value: (r) => fmt.format(r.operations) }
  ], p.mismatchProducts))
  main.append(products)

  document.getElementById('generated').textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString()
}

async function load() {
  const main = document.querySelector('main')
  main.classList.add('loading')
  for (const button of document.querySelectorAll('.periods button')) {
    button.setAttribute('aria-pressed', String(button.dataset.period === state.period))
  }
  const params = new URLSearchParams({ env: state.env, period: state.period })
  history.replaceState(null, '', '?' + params)
  try {
    const response = await fetch('/api/summary?' + params, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(response.status + ' ' + (await response.text()))
    render(await response.json())
  } catch (error) {
    main.replaceChildren(el('div', { class: 'banner', text: 'Could not load the dashboard: ' + error.message }))
  } finally {
    main.classList.remove('loading')
  }
}

document.querySelector('.periods').addEventListener('click', (event) => {
  const period = event.target.dataset && event.target.dataset.period
  if (period && period !== state.period) { state.period = period; load() }
})
document.getElementById('env').addEventListener('change', (event) => { state.env = event.target.value; load() })
document.getElementById('refresh').addEventListener('click', () => load())
load()
`

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!
  )
}

/** The dashboard page, with the selected dataset and period and the script's nonce. */
export function renderPage({
  env,
  period,
  email,
  nonce
}: {
  env: string
  period: string
  email: string | undefined
  nonce: string
}): string {
  const envOptions = Object.keys(DATASETS)
    .map(
      (name) =>
        `<option value="${escapeHtml(name)}"${name === env ? ' selected' : ''}>${escapeHtml(name)}</option>`
    )
    .join('')
  const periodButtons = Object.keys(PERIODS)
    .map(
      (key) =>
        `<button type="button" data-period="${escapeHtml(key)}" aria-pressed="${key === period}">${escapeHtml(key)}</button>`
    )
    .join('')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Cloudflare API MCP · Admin</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body data-env="${escapeHtml(env)}" data-period="${escapeHtml(period)}">
<header>
  <h1>Cloudflare API MCP</h1>
  <div class="periods" role="group" aria-label="Period">${periodButtons}</div>
  <label>Dataset <select id="env">${envOptions}</select></label>
  <button type="button" id="refresh">Refresh</button>
  <span class="spacer"></span>
  <span class="meta" id="generated"></span>
  ${email ? `<span class="meta">${escapeHtml(email)}</span>` : ''}
</header>
<main></main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`
}
