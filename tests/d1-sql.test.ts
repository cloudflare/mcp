import { describe, expect, it } from 'vitest'
import { classifyD1Sql } from '../src/tools/d1-sql'

describe('classifyD1Sql', () => {
  it.each([
    'SELECT * FROM users WHERE id = ?',
    'select replace(name, "a", "b") from users',
    'SELECT 1; SELECT 2;',
    'VALUES (1), (2)',
    'WITH recent AS (SELECT * FROM orders) SELECT count(*) FROM recent',
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 5) SELECT n FROM c',
    'WITH x AS MATERIALIZED (SELECT 1), y AS (SELECT 2) VALUES (3)',
    'EXPLAIN QUERY PLAN SELECT * FROM users WHERE email = ?1',
    'explain select 1',
    'PRAGMA table_list',
    'PRAGMA table_info(users)',
    'pragma main.index_list("users")',
    "SELECT * FROM pragma_table_info('users')",
    "SELECT ';DELETE FROM users' AS s",
    'SELECT "delete" FROM [update] -- ; DROP TABLE users',
    'SELECT 1 /* ; DROP TABLE users */',
    "SELECT 'it''s'; SELECT `a``b` FROM t",
    'SELECT count(*) FILTER (WHERE a > 1) OVER w FROM t WINDOW w AS (ORDER BY a NULLS LAST)'
  ])('accepts %s', (sql) => {
    expect(classifyD1Sql(sql)).toEqual({ readOnly: true })
  })

  it.each([
    ['INSERT INTO users VALUES (1)', 'INSERT statement is not read-only'],
    ['replace into users values (1)', 'REPLACE statement is not read-only'],
    ['SELECT 1; DROP TABLE users', 'Statement 2: DROP statement is not read-only'],
    ['SELECT 1;DELETE FROM users', 'Statement 2: DELETE'],
    ['WITH x AS (SELECT 1) DELETE FROM users WHERE id IN (SELECT * FROM x)', 'WITH … DELETE'],
    ['WITH x AS (SELECT 1) UPDATE users SET a = 1', 'WITH … UPDATE'],
    ['WITH x AS (SELECT 1)', 'Could not find the statement after WITH'],
    ['EXPLAIN DELETE FROM users', 'EXPLAIN: DELETE statement is not read-only'],
    ['EXPLAIN QUERY', 'Expected EXPLAIN QUERY PLAN'],
    ['PRAGMA foreign_keys = OFF', 'Only these read-only PRAGMAs'],
    ['PRAGMA foreign_keys(0)', 'Only these read-only PRAGMAs'],
    ['PRAGMA table_info = 1', "PRAGMA table_info can't be assigned"],
    ['PRAGMA optimize', 'Only these read-only PRAGMAs'],
    ['ATTACH DATABASE "x" AS y', 'ATTACH statement is not read-only'],
    ['CREATE TABLE t (a)', 'CREATE statement is not read-only'],
    ['BEGIN; SELECT 1; COMMIT', 'BEGIN statement is not read-only'],
    ["SELECT 'a\\'; DELETE FROM users; --'", 'Statement 2: DELETE'],
    ["SELECT 'unterminated", 'unterminated string literal'],
    ['SELECT [unterminated', 'unterminated quoted identifier'],
    ['', 'holds no statement'],
    [' ; -- nothing', 'holds no statement'],
    ['(SELECT 1)', 'This statement is not read-only']
  ])('rejects %s', (sql, reason) => {
    const verdict = classifyD1Sql(sql)
    expect(verdict.readOnly).toBe(false)
    expect(verdict.readOnly === false && verdict.reason).toContain(reason)
  })
})
