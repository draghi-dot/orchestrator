// Test-only transport: invoke the real sample HTTP handler without a TCP port.
import { pathToFileURL } from 'node:url'
export async function makeShopFetch(file, accounts) {
  const { createShop } = await import(pathToFileURL(file).href + '?t=' + Date.now())
  const shop = createShop(accounts)
  const handler = shop.listeners('request')[0]
  return async (input, init = {}) => {
    const url = new URL(String(input))
    const req = { url: url.pathname + url.search, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()) }
    let status = 200, headers = {}, body = ''
    const res = { writeHead(code, h) { status = code; headers = h; return this }, end(text = '') { body += text } }
    handler(req, res)
    return new Response(body, { status, headers })
  }
}
if (process.env.QA_TEST_SHOP_PATH) globalThis.fetch = await makeShopFetch(process.env.QA_TEST_SHOP_PATH, { alice: process.env.QA_SAMPLE_ALICE, bob: process.env.QA_SAMPLE_BOB })
