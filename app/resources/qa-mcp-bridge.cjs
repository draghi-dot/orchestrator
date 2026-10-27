#!/usr/bin/env node
'use strict'
// QA DNA MCP bridge: a stdio MCP server that agent CLIs (Claude Code, Codex)
// launch. It owns no logic: tools/list and tools/call are forwarded to the
// QA DNA tool gateway on loopback, authenticated with the task's token.
//
// Env: QA_GATEWAY_URL (http://127.0.0.1:port), QA_GATEWAY_TOKEN.

const readline = require('node:readline')

const GATEWAY = process.env.QA_GATEWAY_URL || ''
const TOKEN = process.env.QA_GATEWAY_TOKEN || ''
const SERVER_INFO = { name: 'qa-dna', version: '0.3.0' }

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

async function gateway(path, body) {
  const res = await fetch(GATEWAY + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(body || {}),
  })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: text }
  }
  if (!res.ok) throw new Error(data.error || 'gateway answered ' + res.status)
  return data
}

function toText(result) {
  const parts = [result.summary || '']
  if (result.data !== undefined) parts.push(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2))
  return parts.filter(Boolean).join('\n\n')
}

async function handle(msg) {
  const { id, method, params } = msg
  const isRequest = id !== undefined && id !== null
  try {
    switch (method) {
      case 'initialize':
        return write({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: (params && params.protocolVersion) || '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: 'QA DNA host tools. Every call is policy-checked and recorded.',
          },
        })
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return
      case 'ping':
        return write({ jsonrpc: '2.0', id, result: {} })
      case 'tools/list': {
        const data = await gateway('/tools')
        return write({ jsonrpc: '2.0', id, result: { tools: data.tools || [] } })
      }
      case 'tools/call': {
        const name = params && params.name
        const result = await gateway('/call', { id, name, arguments: (params && params.arguments) || {} })
        return write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: toText(result) }], isError: result.ok === false } })
      }
      default:
        if (isRequest) write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
    }
  } catch (err) {
    if (!isRequest) return
    if (method === 'tools/call') {
      write({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Host error: ' + (err && err.message) }], isError: true } })
    } else {
      write({ jsonrpc: '2.0', id, error: { code: -32603, message: String((err && err.message) || err) } })
    }
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  void handle(msg)
})
rl.on('close', () => process.exit(0))
