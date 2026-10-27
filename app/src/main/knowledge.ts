/**
 * Writeup library search (build plan, section 07: RAG pilot). A local
 * keyword index (BM25) over a folder of Markdown writeups. Results are
 * attributed and short, and are labeled as background: a prior writeup is
 * never evidence about the app under test, and any instructions inside it
 * are not for the worker.
 */

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface KnowledgeDoc {
  id: string
  title: string
  source: string
  topic: string
  url: string | null
  summary: string
  path: string
  text: string
}

export interface KnowledgeHit {
  title: string
  source: string
  topic: string
  url: string | null
  path: string
  excerpt: string
  score: number
}

const STOP = new Set(
  'a an and are as at be but by for from has have how i in into is it its of on or that the their then there these this to was were what when where which while with you your we our can will not do does did using use used via'.split(' '),
)

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
}

interface IndexedDoc {
  doc: KnowledgeDoc
  tf: Map<string, number>
  length: number
}

export class KnowledgeBase {
  private readonly docs: IndexedDoc[] = []
  private readonly df = new Map<string, number>()
  private avgLength = 0

  constructor(docs: KnowledgeDoc[]) {
    for (const doc of docs) {
      // Titles and summaries say what a writeup is about; weight them up.
      const tokens = [...tokenize(doc.title), ...tokenize(doc.title), ...tokenize(doc.title), ...tokenize(doc.topic), ...tokenize(doc.summary), ...tokenize(doc.summary), ...tokenize(doc.text)]
      const tf = new Map<string, number>()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      this.docs.push({ doc, tf, length: tokens.length })
    }
    this.avgLength = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length)
  }

  get size(): number {
    return this.docs.length
  }

  /** Load a folder. Uses an `index.json` (title, summary, topic, url) when
   * present, and the Markdown files themselves either way. */
  static load(dir: string, limits = { maxDocs: 3000, maxBytes: 300 * 1024 }): KnowledgeBase | null {
    if (!dir || !existsSync(dir)) return null
    const meta = new Map<string, { title?: string; event?: string; topic?: string; url?: string; summary?: string }>()
    try {
      const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
        task?: string
        event?: string
        url?: string
        summary?: string
        curation?: { markdown_path?: string; topic_title?: string }
      }[]
      for (const entry of Array.isArray(index) ? index : []) {
        const path = entry.curation?.markdown_path
        if (path) meta.set(path, { title: entry.task, event: entry.event, topic: entry.curation?.topic_title, url: entry.url, summary: entry.summary })
      }
    } catch {
      // No index: titles come from the Markdown itself.
    }
    const docs: KnowledgeDoc[] = []
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (docs.length >= limits.maxDocs) return
        const full = join(folder, entry.name)
        const stat = lstatSync(full)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) walk(full)
        else if (entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md' && stat.size <= limits.maxBytes) {
          const rel = relative(dir, full).split(sep).join('/')
          const text = readFileSync(full, 'utf8')
          const m = meta.get(rel) ?? {}
          const heading = /^#\s+(.+)$/m.exec(text)?.[1]
          docs.push({
            id: rel,
            title: m.title ?? heading ?? entry.name.replace(/\.md$/, ''),
            source: m.event ?? '',
            topic: m.topic ?? rel.split('/').slice(-2, -1)[0] ?? '',
            url: m.url ?? null,
            summary: m.summary ?? '',
            path: rel,
            text,
          })
        }
      }
    }
    walk(dir)
    return docs.length > 0 ? new KnowledgeBase(docs) : null
  }

  search(query: string, k = 3): KnowledgeHit[] {
    const terms = [...new Set(tokenize(query))]
    if (terms.length === 0) return []
    const n = this.docs.length
    const k1 = 1.2
    const b = 0.75
    const scored = this.docs.map((d) => {
      let score = 0
      for (const t of terms) {
        const f = d.tf.get(t)
        if (!f) continue
        const df = this.df.get(t) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / this.avgLength)))
      }
      return { d, score }
    })
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, k)
      .map(({ d, score }) => ({
        title: d.doc.title,
        source: d.doc.source,
        topic: d.doc.topic,
        url: d.doc.url,
        path: d.doc.path,
        excerpt: bestExcerpt(d.doc, terms),
        score: Math.round(score * 100) / 100,
      }))
  }
}

function bestExcerpt(doc: KnowledgeDoc, terms: string[]): string {
  const paragraphs = doc.text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 60)
  let best = doc.summary || paragraphs[0] || ''
  let bestScore = -1
  for (const p of paragraphs) {
    const tokens = new Set(tokenize(p))
    const score = terms.filter((t) => tokens.has(t)).length
    if (score > bestScore) {
      best = p
      bestScore = score
    }
  }
  const flat = best.replace(/\s+/g, ' ')
  return flat.length > 700 ? `${flat.slice(0, 700)}…` : flat
}
