import { useCallback, useEffect, useRef, useState } from 'react'
import type { Command, CommandResults, Queries, QueryName } from '../../../shared/ipc'

export class ApiError extends Error {
  constructor(
    readonly errorName: string,
    message: string,
  ) {
    super(message)
  }
}

export async function query<K extends QueryName>(name: K, args: Queries[K]['args']): Promise<Queries[K]['result']> {
  const result = await window.qa.query(name, args)
  if (!result.ok) throw new ApiError(result.error.name, result.error.message)
  return result.value
}

export async function command<C extends Command>(cmd: C): Promise<CommandResults[C['type']]> {
  const result = await window.qa.command(cmd)
  if (!result.ok) throw new ApiError(result.error.name, result.error.message)
  return result.value
}

export interface QueryState<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  refetch: () => void
}

/** Read a server fact; refetch whenever `version` changes (bumped by the
 * live event stream when something relevant committed). */
export function useQuery<K extends QueryName>(name: K, args: Queries[K]['args'], version: number | string = 0): QueryState<Queries[K]['result']> {
  const [data, setData] = useState<Queries[K]['result']>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  const key = JSON.stringify(args ?? null)
  const latest = useRef(0)

  useEffect(() => {
    const id = ++latest.current
    setLoading(true)
    query(name, (key === 'null' ? undefined : JSON.parse(key)) as Queries[K]['args'])
      .then((value) => {
        if (id !== latest.current) return
        setData(value)
        setError(null)
      })
      .catch((err: unknown) => {
        if (id !== latest.current) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (id === latest.current) setLoading(false)
      })
    return () => { latest.current += 1 }
  }, [name, key, version, tick])

  const refetch = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, loading, refetch }
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}
