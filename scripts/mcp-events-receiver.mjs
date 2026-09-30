import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'

const secret = process.env.MCP_EVENT_SIGNING_SECRET
if (!secret?.startsWith('whsec_'))
  throw new Error('Set MCP_EVENT_SIGNING_SECRET to whsec_<base64 key>')
const key = Buffer.from(secret.slice(6), 'base64')
if (key.length < 24 || key.length > 64) throw new Error('Signing key must contain 24–64 bytes')
const port = Number(process.env.MCP_EVENT_RECEIVER_PORT ?? 8788)
const deliveryStatus = Number(process.env.MCP_EVENT_RESPONSE_STATUS ?? 204)
if (!Number.isInteger(deliveryStatus) || deliveryStatus < 200 || deliveryStatus > 599)
  throw new Error('Invalid MCP_EVENT_RESPONSE_STATUS')

createServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || request.url !== '/events') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > 256 * 1024) {
        response.writeHead(413).end()
        return
      }
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    const id = request.headers['webhook-id']
    const timestamp = request.headers['webhook-timestamp']
    const signatures = String(request.headers['webhook-signature'] ?? '').split(' ')
    const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest()
    const valid = signatures.some((signature) => {
      if (!signature.startsWith('v1,')) return false
      const actual = Buffer.from(signature.slice(3), 'base64')
      return actual.length === expected.length && timingSafeEqual(actual, expected)
    })
    if (
      !id ||
      !/^\d+$/.test(timestamp ?? '') ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
      !valid
    ) {
      response.writeHead(401).end()
      return
    }
    const event = JSON.parse(body)
    if (event.type === 'verification') {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ challenge: event.challenge }))
      console.log('Callback verified')
      return
    }
    if (event.eventId !== id) {
      response.writeHead(400).end()
      return
    }
    console.log(
      JSON.stringify(
        { subscription: request.headers['x-mcp-subscription-id'], status: deliveryStatus, event },
        null,
        2
      )
    )
    response.writeHead(deliveryStatus).end()
  } catch {
    response.writeHead(400).end()
  }
}).listen(port, '127.0.0.1', () =>
  console.log(`MCP event receiver listening on http://127.0.0.1:${port}/events`)
)
