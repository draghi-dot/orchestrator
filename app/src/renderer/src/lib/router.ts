import { useEffect, useState } from 'react'

export interface Route {
  path: string[]
  params: URLSearchParams
}

function parse(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [pathPart, queryPart = ''] = raw.split('?')
  return { path: pathPart.split('/').filter(Boolean), params: new URLSearchParams(queryPart) }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function navigate(path: string, params?: Record<string, string | number | null | undefined>): void {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) if (v !== null && v !== undefined && v !== '') search.set(k, String(v))
  const qs = search.toString()
  window.location.hash = `#${path}${qs ? `?${qs}` : ''}`
}

/** Update query params in place without adding a history entry. */
export function replaceParams(params: Record<string, string | number | null | undefined>): void {
  const current = parse(window.location.hash)
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') current.params.delete(k)
    else current.params.set(k, String(v))
  }
  const qs = current.params.toString()
  const next = `#/${current.path.join('/')}${qs ? `?${qs}` : ''}`
  history.replaceState(null, '', next)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}
