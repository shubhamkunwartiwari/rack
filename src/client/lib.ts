import { useEffect, useState } from 'react'

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = (await response.json().catch(() => {
    throw new Error('Could not reach the server. Please try again.')
  })) as T & { error?: string }
  if (!response.ok)
    throw new Error(body.error || 'The request failed. Please try again.')
  return body
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

export function uid(): string {
  return crypto.randomUUID()
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function formatParams(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
  return value.toFixed(0)
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  const gb = bytes / 1e9
  if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${(gb * 1000).toFixed(0)} MB`
}

export function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '0 h'
  if (hours >= 1000) return `${(hours / 1000).toFixed(1)}K h`
  return `${hours.toFixed(0)} h`
}

export function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0'
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function relativeDate(ts: number): string {
  const days = Math.round((ts - Date.now()) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days > 0) return `in ${days}d`
  return `${Math.abs(days)}d ago`
}

export function weeksToMonths(weeks: number): number {
  return (weeks * 7) / 30.44
}

export function addWeeks(date: number, weeks: number): number {
  return date + weeks * 7 * 86_400_000
}

export function currentWeek(startDate: number): number {
  return Math.max(0, (Date.now() - startDate) / (7 * 86_400_000))
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}

export function pct(value: number, total: number): string {
  if (total <= 0) return '0%'
  return `${Math.round((value / total) * 100)}%`
}
