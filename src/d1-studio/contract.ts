import { z } from 'zod'

/** The App's HTML resource, served as `text/html;profile=mcp-app`. */
export const D1_STUDIO_RESOURCE_URI = 'ui://cloudflare/d1-studio.html'

/** The tool name. A permanent contract. */
export const D1_STUDIO_TOOL = 'd1_studio'

/** The most queries one call runs: the answer and the earlier steps that led to it. */
export const MAX_QUERIES = 8
/** The most rows a query's result carries to the view. The model reads far fewer (see `modelText`). */
export const MAX_ROWS = 200
/** The rows the model reads in the text result, when the view shows the rest. */
export const MODEL_ROWS = 20

const QueryInput = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .describe(
      'What the query answers, in a few words, for the card heading, e.g. "Top partners by no-shows".'
    ),
  sql: z.string().min(1).max(100_000).describe('One read-only SQLite statement.')
})

export const D1StudioInputSchema = z.object({
  account_id: z
    .string()
    .optional()
    .describe('Account identifier. Optional when the session has exactly one account.'),
  database_id: z.string().min(1).describe('D1 database identifier (UUID), from d1_list.'),
  title: QueryInput.shape.title.optional(),
  sql: QueryInput.shape.sql
    .optional()
    .describe(
      "One read-only SQLite statement (SELECT, WITH, VALUES, EXPLAIN or a reporting PRAGMA) whose rows answer the user's question. Omit to list the database's tables."
    ),
  steps: z
    .array(
      QueryInput.extend({
        note: z
          .string()
          .max(240)
          .optional()
          .describe('What you were checking, in one sentence, e.g. "How a no-show is recorded".')
      })
    )
    .max(MAX_QUERIES - 1)
    .optional()
    .describe(
      'Earlier read-only queries that led to the answer, oldest first. Each is run again and shown, in order, as the train of thought behind the answer.'
    )
})

/** One value in a result row, as D1 returns it. Blobs and objects arrive as JSON text. */
export const D1CellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
export type D1Cell = z.infer<typeof D1CellSchema>

/** What D1 reports about a statement it ran. */
export const D1MetaSchema = z.object({
  /** Time D1 spent running the SQL, without the network. */
  durationMs: z.number().nullable(),
  /** What D1 bills reads by. */
  rowsRead: z.number().nullable(),
  rowsWritten: z.number().nullable()
})

/**
 * How one statement ended. Every case is explicit, so the view never infers a
 * state from missing fields:
 * - `rows`: D1 ran it. `rows` may be empty; `rowCount` is what D1 returned
 *   before the {@link MAX_ROWS} cap, so `rowCount > rows.length` means the
 *   view holds a prefix.
 * - `failed`: D1 refused the SQL (a syntax error, an unknown column), or
 *   the result was too large to read. `token` is the identifier the error
 *   names, for underlining.
 *
 * A statement that isn't one read never gets an outcome: the tool refuses
 * the whole call before sending anything.
 */
export const D1OutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('rows'),
    columns: z.array(z.string()),
    rows: z.array(z.array(D1CellSchema)),
    rowCount: z.number().int().nonnegative(),
    meta: D1MetaSchema
  }),
  z.object({
    status: z.literal('failed'),
    error: z.string(),
    token: z.string().optional(),
    /**
     * For an unknown column or table: the name the error most likely meant,
     * written as `token` is (`a.start_at` → `a.starts_at`), and the table it
     * is in, when it is a column.
     */
    fix: z.object({ use: z.string(), table: z.string().optional() }).optional()
  })
])
export type D1Outcome = z.infer<typeof D1OutcomeSchema>

/**
 * One query and how it ended. `purpose` says why it was run: the agent's
 * `query`, or `tables`, the listing the tool runs when no SQL is given (so an
 * empty result there means an empty database, not an empty answer).
 */
export const D1QuerySchema = z.object({
  purpose: z.enum(['query', 'tables']),
  title: z.string(),
  sql: z.string(),
  note: z.string().optional(),
  outcome: D1OutcomeSchema
})
export type D1Query = z.infer<typeof D1QuerySchema>

/** What the view shows: the database, the answer and the queries that led to it. */
export const D1StudioResultSchema = z.object({
  kind: z.literal('d1_studio'),
  database: z.object({
    accountId: z.string(),
    id: z.string(),
    name: z.string()
  }),
  /** The database's table and view names, for colouring them in SQL. */
  tables: z.array(z.string()),
  answer: D1QuerySchema,
  /** Earlier queries, oldest first. Empty for a single query. */
  steps: z.array(D1QuerySchema),
  /** When D1 answered, in ms since the epoch, so a card reopened later can say how old its rows are. */
  readAt: z.number().optional()
})
export type D1StudioResult = z.infer<typeof D1StudioResultSchema>

export const D1_STUDIO_TOOL_CONFIG = {
  title: 'D1 Studio',
  description: `Run read-only SQL against a D1 database and show the result as a compact, sortable table the user can copy, edit and re-run. Use it instead of d1_query to show the user rows that answer their question. Pass the earlier queries that led to the answer as steps, so the user sees how you got there. Omit sql to list the tables. Only reads run: a write (INSERT, UPDATE, DELETE, DDL, transactions, most PRAGMAs) or more than one statement is refused without being sent; use d1_query for those, after the user agrees. The text result holds the first ${MODEL_ROWS} rows; the view shows up to ${MAX_ROWS}.`,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true
  }
} as const
