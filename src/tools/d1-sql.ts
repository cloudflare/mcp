/**
 * Decides whether SQL sent to D1 can only read.
 *
 * In SQLite only the statement's head decides this: subqueries, CTE bodies and
 * compound members can only be SELECTs, so a SELECT, VALUES or WITH … SELECT
 * statement can't write. The checks therefore need a tokenizer, not a parser.
 * The tokenizer follows SQLite's own rules for comments, strings and quoted
 * identifiers (tokenize.c), so text it treats as a literal or a comment is
 * what SQLite treats that way. Anything it can't classify is rejected.
 */

/** The verdict for a SQL string. `reason` says which statement was rejected and why. */
export type SqlVerdict = { readOnly: true } | { readOnly: false; reason: string }

type Token =
  | { kind: 'word'; upper: string }
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'semicolon' }
  | { kind: 'symbol'; text: string }
  | { kind: 'other' }

/**
 * The PRAGMAs D1 supports that only report: they read the schema or check
 * integrity, with or without an argument. D1's other PRAGMAs are toggles that
 * also accept `PRAGMA name(value)`, or `optimize`, which runs ANALYZE, so they
 * are left out rather than told apart by syntax.
 *
 * @see https://developers.cloudflare.com/d1/sql-api/sql-statements/#compatible-pragma-statements
 */
const READ_ONLY_PRAGMAS = new Set([
  'FOREIGN_KEY_CHECK',
  'FOREIGN_KEY_LIST',
  'INDEX_INFO',
  'INDEX_LIST',
  'INDEX_XINFO',
  'QUICK_CHECK',
  'TABLE_INFO',
  'TABLE_LIST',
  'TABLE_XINFO'
])

/** What the check accepts, for tool and endpoint descriptions. */
export const READ_ONLY_SQL_SUMMARY = `SELECT, VALUES, WITH … SELECT, EXPLAIN [QUERY PLAN] of one of those, or a PRAGMA that only reports (${[...READ_ONLY_PRAGMAS].map((pragma) => pragma.toLowerCase()).join(', ')})`

/** Keywords that can start the main statement after a WITH clause. */
const WITH_MAIN_KEYWORDS = new Set(['SELECT', 'VALUES', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'])

const ALLOWED =
  'Only SELECT, VALUES, WITH … SELECT, EXPLAIN and read-only PRAGMA statements are allowed'

/** SQLite's whitespace is ASCII only (tokenize.c `CC_SPACE`). */
const SPACE = /[ \t\n\f\r]/
/** SQLite treats every byte >= 0x80 as an identifier character. */
const WORD_START = /[A-Za-z_\u0080-￿]/
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/

/**
 * Splits SQL into the tokens the classifier needs. Throws on input SQLite
 * would also reject as unterminated, so nothing is left ambiguous.
 */
class SqliteTokenizer {
  private position = 0

  constructor(private readonly sql: string) {}

  tokenize(): Token[] {
    const tokens: Token[] = []
    for (let token = this.next(); token !== undefined; token = this.next()) {
      tokens.push(token)
    }
    return tokens
  }

  private next(): Token | undefined {
    this.skipSpaceAndComments()
    if (this.position >= this.sql.length) return undefined

    const char = this.sql[this.position]
    switch (char) {
      case "'":
        this.skipQuoted("'", 'string literal')
        return { kind: 'other' }
      case '"':
        this.skipQuoted('"', 'quoted identifier')
        return { kind: 'other' }
      case '`':
        this.skipQuoted('`', 'quoted identifier')
        return { kind: 'other' }
      case '[':
        this.skipBracketIdentifier()
        return { kind: 'other' }
      case '(':
        this.position++
        return { kind: 'open' }
      case ')':
        this.position++
        return { kind: 'close' }
      case ';':
        this.position++
        return { kind: 'semicolon' }
    }

    if (WORD_START.test(char)) return { kind: 'word', upper: this.readWord().toUpperCase() }
    if (/[0-9]/.test(char) || char === '?' || char === ':' || char === '@' || char === '$') {
      // Numbers and bind parameters (?1, :name, @name, $name).
      this.position++
      this.readWord()
      return { kind: 'other' }
    }

    this.position++
    return { kind: 'symbol', text: char }
  }

  private skipSpaceAndComments(): void {
    while (this.position < this.sql.length) {
      const char = this.sql[this.position]
      if (SPACE.test(char)) {
        this.position++
      } else if (this.sql.startsWith('--', this.position)) {
        const end = this.sql.indexOf('\n', this.position)
        this.position = end === -1 ? this.sql.length : end + 1
      } else if (this.sql.startsWith('/*', this.position)) {
        // SQLite lets a block comment run to the end of the input.
        const end = this.sql.indexOf('*/', this.position + 2)
        this.position = end === -1 ? this.sql.length : end + 2
      } else {
        return
      }
    }
  }

  /** Skips a quoted token in which a doubled quote stands for one quote. */
  private skipQuoted(quote: string, what: string): void {
    let index = this.position + 1
    for (;;) {
      const end = this.sql.indexOf(quote, index)
      if (end === -1) throw new Error(`unterminated ${what}`)
      if (this.sql[end + 1] !== quote) {
        this.position = end + 1
        return
      }
      index = end + 2
    }
  }

  /** Skips a `[identifier]`, which has no escape. */
  private skipBracketIdentifier(): void {
    const end = this.sql.indexOf(']', this.position + 1)
    if (end === -1) throw new Error('unterminated quoted identifier')
    this.position = end + 1
  }

  private readWord(): string {
    const start = this.position
    while (this.position < this.sql.length && WORD_PART.test(this.sql[this.position])) {
      this.position++
    }
    return this.sql.slice(start, this.position)
  }
}

/**
 * Classifies a SQL string, which may hold several `;`-separated statements, as
 * read-only or not. Every statement has to be read-only.
 *
 * @param sql - The SQL D1 would run.
 * @returns `{ readOnly: true }`, or `{ readOnly: false, reason }` naming the problem.
 */
export function classifyD1Sql(sql: string): SqlVerdict {
  let tokens: Token[]
  try {
    tokens = new SqliteTokenizer(sql).tokenize()
  } catch (error) {
    return { readOnly: false, reason: `Could not read the SQL: ${(error as Error).message}.` }
  }

  const statements: Token[][] = [[]]
  for (const token of tokens) {
    if (token.kind === 'semicolon') statements.push([])
    else statements[statements.length - 1].push(token)
  }

  const nonEmpty = statements.filter((statement) => statement.length > 0)
  if (nonEmpty.length === 0) return { readOnly: false, reason: 'The SQL holds no statement.' }

  for (const [index, statement] of nonEmpty.entries()) {
    const problem = statementProblem(statement)
    if (problem) {
      const which = nonEmpty.length > 1 ? `Statement ${index + 1}: ` : ''
      return { readOnly: false, reason: `${which}${problem}` }
    }
  }
  return { readOnly: true }
}

/** Why a single statement isn't read-only, or `undefined` when it is. */
function statementProblem(statement: Token[]): string | undefined {
  const [head] = statement
  const keyword = head.kind === 'word' ? head.upper : undefined

  switch (keyword) {
    case 'SELECT':
    case 'VALUES':
      return undefined
    case 'WITH':
      return withProblem(statement)
    case 'EXPLAIN':
      return explainProblem(statement)
    case 'PRAGMA':
      return pragmaProblem(statement)
    default:
      return `${keyword ?? 'This'} statement is not read-only. ${ALLOWED}.`
  }
}

/**
 * A WITH clause is followed by its main statement, which SQLite lets be a
 * write. CTE names, column lists and bodies sit in or before parentheses, so
 * the first SELECT/VALUES/INSERT/UPDATE/DELETE/REPLACE outside parentheses is
 * the main statement's keyword.
 */
function withProblem(statement: Token[]): string | undefined {
  let depth = 0
  for (const token of statement) {
    if (token.kind === 'open') depth++
    else if (token.kind === 'close') depth--
    else if (depth === 0 && token.kind === 'word' && WITH_MAIN_KEYWORDS.has(token.upper)) {
      return token.upper === 'SELECT' || token.upper === 'VALUES'
        ? undefined
        : `WITH … ${token.upper} statement is not read-only. ${ALLOWED}.`
    }
  }
  return `Could not find the statement after WITH. ${ALLOWED}.`
}

/**
 * EXPLAIN only describes a statement and never runs it. The explained
 * statement still has to be read-only, so this tool only ever accepts reads.
 */
function explainProblem(statement: Token[]): string | undefined {
  let rest = statement.slice(1)
  const [first, second] = rest
  if (first?.kind === 'word' && first.upper === 'QUERY') {
    if (second?.kind !== 'word' || second.upper !== 'PLAN') return 'Expected EXPLAIN QUERY PLAN.'
    rest = rest.slice(2)
  }
  if (rest.length === 0) return 'EXPLAIN needs a statement to explain.'
  const problem = statementProblem(rest)
  return problem ? `EXPLAIN: ${problem}` : undefined
}

/** Accepts `PRAGMA [schema.]name [(argument)]` for the PRAGMAs that only report. */
function pragmaProblem(statement: Token[]): string | undefined {
  let rest = statement.slice(1)
  if (rest[1]?.kind === 'symbol' && rest[1].text === '.') rest = rest.slice(2)

  const [name] = rest
  if (name?.kind !== 'word' || !READ_ONLY_PRAGMAS.has(name.upper)) {
    const allowed = [...READ_ONLY_PRAGMAS].map((pragma) => pragma.toLowerCase()).join(', ')
    return `Only these read-only PRAGMAs are allowed: ${allowed}.`
  }
  if (rest.some((token) => token.kind === 'symbol' && token.text === '=')) {
    return `PRAGMA ${name.upper.toLowerCase()} can't be assigned in a read-only query.`
  }
  return undefined
}
