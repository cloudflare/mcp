/**
 * The short form of a query: what decides the answer (FROM, the WHERE range,
 * GROUP BY, ORDER BY, LIMIT) kept readable, one clause per line, and every cut
 * a marker that holds the text it hides (`6 columns`, `+2 joins`). No per-line
 * ellipsis: a clause wraps with a hanging indent.
 *
 * The tray's corner action (Run, Edit) sits on the last line, so `tailCh`
 * keeps room for it there: a last clause folds at its last top-level AND or
 * comma to make room, and `over` says nothing could, so the view ends the
 * line with a spacer and the action takes the next line instead of covering
 * text.
 */

export type Tok = { text: string } | { fold: string; hidden: string }
export type Line = Tok[]
export type Folded = { lines: Line[]; flow: boolean; cont?: number[]; over?: boolean }
export type FoldMode = 'tail' | 'any'

const CLAUSE =
  /\b(FROM|WHERE|GROUP BY|ORDER BY|LIMIT|HAVING|(?:LEFT |INNER |CROSS |LEFT OUTER )?JOIN)\b/gi

/** Split at top-level clause keywords (not inside parentheses or strings). */
function clauses(flat: string): { kw: string; body: string }[] {
  let depth = 0
  let inStr = false
  const cuts: { at: number; kw: string }[] = [{ at: 0, kw: '' }]
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i]
    if (ch === "'") inStr = !inStr
    if (inStr) continue
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth !== 0) continue
    CLAUSE.lastIndex = i
    const m = CLAUSE.exec(flat)
    if (m && m.index === i && (i === 0 || /\s/.test(flat[i - 1]))) {
      cuts.push({ at: i, kw: m[1].toUpperCase() })
      i += m[0].length - 1
    }
  }
  return cuts
    .map((c, k) => ({
      kw: c.kw,
      body: flat.slice(c.at, k + 1 < cuts.length ? cuts[k + 1].at : flat.length).trim()
    }))
    .filter((c) => c.body)
}

function splitTop(s: string) {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  return [...out, cur].map((x) => x.trim()).filter(Boolean)
}

const t = (text: string): Tok => ({ text })
const f = (fold: string, hidden: string): Tok => ({ fold, hidden })
const join = (parts: Line[]): Line => parts.flatMap((p, i) => (i ? [t(' '), ...p] : p))

/** Width in mono characters; a marker is set in a smaller sans face with padding. */
export function widthOf(line: Line) {
  return line.reduce((w, k) => w + ('text' in k ? k.text.length : k.fold.length * 0.78 + 1.6), 0)
}

/**
 * @param cpl characters that fit on one line of the short SQL
 * @param tailCh characters kept free at the end of the last line (the tray's corner action)
 */
export function foldSql(sql: string, cpl: number, tailCh = 0, mode: FoldMode = 'tail'): Folded {
  const f0 = foldTail(sql, cpl, tailCh)
  if (!tailCh || f0.flow) return f0
  const last = f0.lines[f0.lines.length - 1]
  if (widthOf(last) <= cpl - tailCh) return f0
  if (mode === 'tail') return { ...f0, over: true }
  // 'any': the last line, whatever clause it is, splits at its last top-level AND (or comma) where what follows fits
  // beside the corner action and what precedes fits the line. The continuation hangs 2ch, like a wrapped clause.
  if (!last.every((k) => 'text' in k)) return { ...f0, over: true }
  const text = last.map((k) => (k as { text: string }).text).join('')
  const cuts: number[] = []
  let depth = 0
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'") inStr = !inStr
    if (inStr) continue
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth) continue
    if (text.startsWith(' AND ', i) || text.startsWith(' OR ', i)) cuts.push(i + 1)
    if (ch === ',' && text[i + 1] === ' ') cuts.push(i + 2)
  }
  for (const at of cuts.reverse()) {
    const head = text.slice(0, at).trimEnd()
    const tail = text.slice(at)
    if (head.length <= cpl && tail.length + 2 <= cpl - tailCh) {
      const lines = [...f0.lines.slice(0, -1), [t(head)], [t(tail)]]
      return { lines, flow: false, cont: [lines.length - 1] }
    }
  }
  return { ...f0, over: true }
}

function foldTail(sql: string, cpl: number, tailCh: number): Folded {
  const flat = sql.replace(/\s+/g, ' ').trim()
  const cs = clauses(flat)
  if (!cs.length || !/^SELECT\b/i.test(cs[0].body)) return { lines: [[t(flat)]], flow: true }
  // One line as written when it fits; otherwise one clause per line, and nothing is cut when it's short.
  if (flat.length <= cpl - tailCh) return { lines: [[t(flat)]], flow: false }
  const cut = flat.length > cpl * 2

  const list = cs[0].body.replace(/^SELECT\s+(DISTINCT\s+)?/i, '')
  const head = cs[0].body.slice(0, cs[0].body.length - list.length)
  const cols = splitTop(list)
  const sel: Line =
    cut && (cols.length > 3 || list.length > 40)
      ? [t(head), f(`${cols.length} ${cols.length === 1 ? 'column' : 'columns'}`, list)]
      : [t(cs[0].body)]
  const from = cs.filter((c) => c.kw === 'FROM').map((c) => [t(c.body)] as Line)
  const joins = cs.filter((c) => c.kw.endsWith('JOIN'))
  const joinTok: Line[] = !cut
    ? joins.map((j) => [t(j.body)])
    : joins.length
      ? [
          [
            f(
              `+${joins.length} ${joins.length === 1 ? 'join' : 'joins'}`,
              joins.map((j) => j.body).join('\n')
            )
          ]
        ]
      : []
  const where = cs.filter((c) => c.kw === 'WHERE').map((c) => [t(c.body)] as Line)
  const group = cs
    .filter((c) => c.kw === 'GROUP BY' || c.kw === 'HAVING')
    .map((c) => [t(c.body)] as Line)
  const order = cs
    .filter((c) => c.kw === 'ORDER BY' || c.kw === 'LIMIT')
    .map((c) => [t(c.body)] as Line)

  // If SELECT … FROM can't share a line, FROM starts its own rather than wrapping mid-clause.
  const first = join([sel, ...from, ...joinTok])
  const lines: Line[] =
    widthOf(first) <= cpl || !from.length ? [first] : [sel, join([...from, ...joinTok])]
  if (where.length) lines.push(join(where))
  const tail = join([...group, ...order])
  if (tail.length) {
    if (widthOf(tail) <= cpl - tailCh || !group.length || !order.length) lines.push(tail)
    else {
      // The tail splits at ORDER BY. GROUP BY goes up beside the line above when it fits there, so the split costs no
      // line; otherwise it takes its own.
      const prev = lines[lines.length - 1]
      const up = join([prev, join(group)])
      if (widthOf(up) <= cpl) lines[lines.length - 1] = up
      else lines.push(join(group))
      lines.push(join(order))
    }
  }
  return { lines, flow: false }
}

/**
 * Where a line of SQL may wrap. Top level: before AND, OR, a clause keyword, or
 * (inside a long select item) AS or an operator, and after a comma. Inside
 * parentheses: only before WHEN, THEN, ELSE, END, AND, OR or an operator, and
 * never around a comparison. Every other space becomes a no-break space, so a
 * wrap never splits `a.status = 'no-show'`, `AS revenue_lost` or `ROUND(…, 3)`.
 */
const BREAK_BEFORE = /^(AND|OR|FROM|WHERE|GROUP|ORDER|LIMIT|HAVING|JOIN|LEFT|INNER|CROSS|ON)$/i
/** Before AS or an operator only in a long item, so a short item breaks at its comma and `AS lost` is never alone. */
const BREAK_IN_LONG_ITEM = /^(AS|[-+/*]|\|\|)$/i
const LONG_ITEM = 30
const BREAK_BEFORE_IN = /^(WHEN|THEN|ELSE|END\)*[,;]?|AND|OR|[-+/*]|\|\|)$/i
const COMPARISON = /^(=|==|!=|<>|<=|>=|<|>|LIKE|GLOB|IN|IS|NOT|BETWEEN)$/i

export function wrapOnlyAtClauses(line: Line): Line {
  let depth = 0
  let inStr = false
  let item = 0
  return line.map((tok) => {
    if (!('text' in tok)) return tok
    const s = tok.text
    let out = ''
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!
      item++
      if (ch === "'") inStr = !inStr
      if (!inStr && ch === '(') depth++
      if (!inStr && ch === ')') depth--
      if (!inStr && depth <= 0 && ch === ',') item = 0
      if (ch !== ' ') {
        out += ch
        continue
      }
      const prev = /(\S+)$/.exec(s.slice(0, i))?.[1] ?? ''
      const next = /^(\S+)/.exec(s.slice(i + 1))?.[1] ?? ''
      const wrap = inStr
        ? false
        : depth <= 0
          ? BREAK_BEFORE.test(next) ||
            prev.endsWith(',') ||
            (BREAK_IN_LONG_ITEM.test(next) && item >= LONG_ITEM)
          : BREAK_BEFORE_IN.test(next) && !COMPARISON.test(prev)
      out += wrap ? ' ' : '\u00a0'
    }
    return { text: out }
  })
}
