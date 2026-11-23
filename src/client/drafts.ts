import type { GraphPayload, PlanPayload, ProjectSettings } from '../shared/types'

/** A pending edit mirrored to localStorage so a refresh cannot lose it. */
export type Draft = {
  id: string
  at: number
  graph?: GraphPayload
  plan?: PlanPayload
  settings?: ProjectSettings
}

const draftKey = (id: string) => `rack:draft:${id}`

export function storeDraft(draft: Draft) {
  try {
    window.localStorage.setItem(draftKey(draft.id), JSON.stringify(draft))
  } catch {
    // Storage can be unavailable (private mode or quota); the server save still runs.
  }
}

export function readDraft(id: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(id))
    if (!raw) return null
    const draft = JSON.parse(raw) as Draft
    return draft?.id === id && typeof draft.at === 'number' ? draft : null
  } catch {
    return null
  }
}

export function clearDraft(id: string) {
  try {
    window.localStorage.removeItem(draftKey(id))
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

/** Fold a partial edit into whatever draft this project already holds. */
export function mergeDraft(id: string, patch: Omit<Partial<Draft>, 'id' | 'at'>) {
  storeDraft({ ...(readDraft(id) ?? {}), ...patch, id, at: Date.now() })
}
