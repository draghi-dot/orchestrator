import type { ReactNode } from 'react'

/** A small, safe Markdown renderer for agent-written reports. Builds React
 * elements only (no HTML injection); links render as text. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i += 1
      out.push(
        <pre key={key++} className="code">
          {body.join('\n')}
        </pre>,
      )
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      const content = inline(heading[2])
      out.push(level === 1 ? <h1 key={key++}>{content}</h1> : level === 2 ? <h2 key={key++}>{content}</h2> : <h3 key={key++}>{content}</h3>)
      i += 1
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        if (!/^\s*\|?\s*:?-{2,}/.test(lines[i])) rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
        i += 1
      }
      const [head, ...body] = rows
      out.push(
        <table key={key++}>
          <thead>
            <tr>{head.map((c, n) => <th key={n}>{inline(c)}</th>)}</tr>
          </thead>
          <tbody>
            {body.map((r, rn) => (
              <tr key={rn}>{r.map((c, n) => <td key={n}>{inline(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''))
      const children = items.map((t, n) => <li key={n}>{inline(t)}</li>)
      out.push(ordered ? <ol key={key++}>{children}</ol> : <ul key={key++}>{children}</ul>)
      continue
    }
    if (!line.trim()) {
      i += 1
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|\s*([-*]|\d+\.)\s+|\s*\|)/.test(lines[i])) para.push(lines[i++])
    out.push(<p key={key++}>{inline(para.join(' '))}</p>)
  }
  return <div className="prose">{out}</div>
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let n = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push(text.slice(last, m.index))
    const token = m[0]
    if (token.startsWith('`')) parts.push(<code key={n++}>{token.slice(1, -1)}</code>)
    else if (token.startsWith('**')) parts.push(<strong key={n++}>{token.slice(2, -2)}</strong>)
    else parts.push(<span key={n++}>{/^\[([^\]]+)\]/.exec(token)?.[1]}</span>)
    last = m.index! + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}
