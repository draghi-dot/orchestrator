import { createServer } from 'node:http'

const rates = { SAVE10: 0.10, SAVE20: 0.15 }
const orders = {
  '101': { id: '101', owner: 'alice', items: ['Notebook'], total: 60, address: '10 Example Street' },
  '102': { id: '102', owner: 'bob', items: ['Notebook', 'Notebook'], total: 120, address: '20 Example Street' },
}
const round = (n) => Math.round(n * 100) / 100
const shipping = (subtotal) => subtotal > 100 ? 0 : 8

export function createShop(accounts = { alice: process.env.QA_SAMPLE_ALICE, bob: process.env.QA_SAMPLE_BOB }) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    const user = Object.entries(accounts).find(([, token]) => token && req.headers.authorization === token)?.[0]
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' })
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>Sample Shop</title></head><body>
        <h1>Sample Shop</h1><p>Notebooks: $60 each. Default cart subtotal $120.</p>
        <p>SAVE10 gives 10% off. SAVE20 gives 20% off.</p>
        <p>Free shipping on a subtotal of $100 or more; otherwise $8. Shipping is separate from total.</p>
        <p>Quantity must be an integer from 1 to 99. Invalid quantities and unknown coupons return HTTP 422.</p>
        <form action="/api/cart" method="get"><label>Coupon <input name="code"></label><label>Quantity <input name="quantity" value="2"></label><button>View cart</button></form>
        <p>Orders are private: accessing another customer's order returns HTTP 403.</p>
        <a href="/api/orders/101">Alice's order 101</a> <a href="/api/orders/102">Bob's order 102</a>
        <a href="/api/session">Current account</a> <a href="/api/shipping?subtotal=100">Shipping quote</a>
      </body></html>`)
      return
    }
    if (url.pathname === '/api/cart') {
      const quantity = Number(url.searchParams.get('quantity') ?? 2)
      if (!Number.isInteger(quantity) || quantity > 99) return json(422, { error: 'invalid_quantity' })
      const code = url.searchParams.get('code') ?? ''
      if (code && !Object.hasOwn(rates, code)) return json(422, { error: 'invalid_code' })
      const subtotal = round(quantity * 60)
      const discount = round(subtotal * (rates[code] ?? 0))
      return json(200, { quantity, subtotal, discount, total: round(subtotal - discount), shipping: shipping(subtotal) })
    }
    if (url.pathname === '/api/shipping') {
      const subtotal = Number(url.searchParams.get('subtotal'))
      if (!Number.isFinite(subtotal) || subtotal < 0) return json(422, { error: 'invalid_subtotal' })
      return json(200, { subtotal, shipping: shipping(subtotal) })
    }
    if (url.pathname === '/api/session') return user ? json(200, { user }) : json(401, { error: 'sign_in_required' })
    const orderId = /^\/api\/orders\/(\d+)$/.exec(url.pathname)?.[1]
    if (orderId) {
      if (!user) return json(401, { error: 'sign_in_required' })
      const order = orders[orderId]
      return order ? json(200, order) : json(404, { error: 'not_found' })
    }
    json(404, { error: 'not_found' })
  })
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const server = createShop()
  server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () => {
    console.log(`Sample Shop ready on 127.0.0.1:${server.address().port}`)
  })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)))
}
