import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { mergeDraft } from './drafts'
import {
  ACCELERATORS,
  BLOCK_KINDS,
  BLOCK_META,
  PRECISIONS,
  blockParams,
  canConnect,
  trainingBytes,
  createsCycle,
  defaultConfig,
  estimateProject,
} from '../shared/estimate'
import type {
  Block,
  BlockConfig,
  BlockKind,
  Edge,
  PortType,
  Precision,
  Project,
  ProjectSettings,
} from '../shared/types'
import {
  clamp,
  formatBytes,
  formatHours,
  formatMoney,
  formatParams,
  useMediaQuery,
  uid,
} from './lib'
import { Field, Icon, NumberInput, Segmented, type Notify } from './ui'

const NODE_W = 208
const NODE_H = 100
const WORLD_LIMIT = 12_000

type View = { x: number; y: number; k: number }
type SaveState = 'saved' | 'saving' | 'offline' | 'error'
type Mode = 'select' | 'connect' | 'pan'

function blockSummary(block: Block): [string, string] {
  const c = block.config
  switch (block.kind) {
    case 'embedding':
      return [`vocab ${c.vocab.toLocaleString()} · d ${c.dModel}`, `seq ${c.seqLen} · ${c.precision}`]
    case 'attention':
      return [`d ${c.dModel} · ${c.layers} layers`, `heads ${c.heads} · kv ${c.kvHeads} · ${c.precision}`]
    case 'ffn':
      return [`d ${c.dModel} · ffn ${c.ffnWidth}`, `${c.layers} layers · ${c.precision}`]
    case 'moe':
      return [`${c.experts} experts · top-${c.topK}`, `d ${c.dModel} · ffn ${c.ffnWidth}`]
    case 'projection':
      return [`d ${c.dModel} → vocab ${c.vocab}`, `unembedding · ${c.precision}`]
    case 'norm':
      return [`d ${c.dModel} · ${c.layers} layers`, 'scale + bias only']
    case 'loss':
      return [`seq ${c.seqLen} · batch ${c.batch}`, 'requires logits']
    case 'residual':
      return ['additive skip', 'no parameters']
    case 'custom':
      return [`d ${c.dModel}`, 'outside the estimate']
  }
}

export function Canvas({
  project,
  saveState,
  onGraph,
  onSettings,
  notify,
  onFocusBlock,
}: {
  project: Project
  saveState: SaveState
  onGraph: (blocks: Block[], edges: Edge[]) => void
  onSettings: (settings: ProjectSettings) => void
  notify: Notify
  onFocusBlock?: (id: string | null) => void
}) {
  const compact = useMediaQuery('(max-width: 900px)')
  const [blocks, setBlocks] = useState<Block[]>(project.blocks)
  const [edges, setEdges] = useState<Edge[]>(project.edges)
  const [selected, setSelected] = useState<string[]>([])
  const [mode, setMode] = useState<Mode>('select')
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 0.85 })
  const [draft, setDraft] = useState<{ fromId: string; x: number; y: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [pendingSource, setPendingSource] = useState<string | null>(null)
  // Holds the rejected link so the offending edge can flash in the risk accent.
  const [rejected, setRejected] = useState<{ fromId: string; toId: string } | null>(null)

  const viewportRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef(view)
  const blocksRef = useRef(blocks)
  const edgesRef = useRef(edges)
  const selectedRef = useRef(selected)
  const modeRef = useRef(mode)
  const spaceRef = useRef(false)
  const history = useRef<{ blocks: Block[]; edges: Edge[] }[]>([
    { blocks: project.blocks, edges: project.edges },
  ])
  const cursor = useRef(0)
  const configTimer = useRef<number | undefined>(undefined)
  const rejectTimer = useRef<number | undefined>(undefined)

  viewRef.current = view
  blocksRef.current = blocks
  edgesRef.current = edges
  selectedRef.current = selected
  modeRef.current = mode

  useEffect(() => {
    const repaired = separateOverlaps(project.blocks)
    setBlocks(repaired)
    setEdges(project.edges)
    setSelected([])
    history.current = [{ blocks: repaired, edges: project.edges }]
    cursor.current = 0
    // A stacked pair is a placement bug; separate it once and keep the fix.
    if (repaired !== project.blocks) onGraph(repaired, project.edges)
    // Resetting the canvas is tied to opening a different project.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  function commitSnapshot(next: { blocks: Block[]; edges: Edge[] }) {
    history.current = history.current.slice(0, cursor.current + 1)
    history.current.push(next)
    if (history.current.length > 50) history.current.shift()
    cursor.current = history.current.length - 1
    onGraph(next.blocks, next.edges)
  }

  function applyGraph(next: { blocks: Block[]; edges: Edge[] }, transient = false) {
    setBlocks(next.blocks)
    setEdges(next.edges)
    blocksRef.current = next.blocks
    edgesRef.current = next.edges
    if (!transient) commitSnapshot(next)
  }

  function commitWorking() {
    commitSnapshot({ blocks: blocksRef.current, edges: edgesRef.current })
  }

  function scheduleCommit() {
    window.clearTimeout(configTimer.current)
    configTimer.current = window.setTimeout(commitWorking, 300)
  }

  function undo() {
    if (cursor.current <= 0) return
    cursor.current -= 1
    const snapshot = history.current[cursor.current]!
    setBlocks(snapshot.blocks)
    setEdges(snapshot.edges)
    blocksRef.current = snapshot.blocks
    edgesRef.current = snapshot.edges
    setSelected([])
    onGraph(snapshot.blocks, snapshot.edges)
  }

  function redo() {
    if (cursor.current >= history.current.length - 1) return
    cursor.current += 1
    const snapshot = history.current[cursor.current]!
    setBlocks(snapshot.blocks)
    setEdges(snapshot.edges)
    blocksRef.current = snapshot.blocks
    edgesRef.current = snapshot.edges
    setSelected([])
    onGraph(snapshot.blocks, snapshot.edges)
  }

  function toWorld(clientX: number, clientY: number) {
    const rect = viewportRef.current?.getBoundingClientRect()
    const current = viewRef.current
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    return {
      x: (clientX - left - current.x) / current.k,
      y: (clientY - top - current.y) / current.k,
    }
  }

  function addBlock(kind: BlockKind, world?: { x: number; y: number }) {
    const point =
      world ??
      (() => {
        const rect = viewportRef.current?.getBoundingClientRect()
        return toWorld(
          (rect?.left ?? 0) + (rect?.width ?? 600) / 2,
          (rect?.top ?? 0) + (rect?.height ?? 400) / 2,
        )
      })()
    const spot = freeSpot(
      blocksRef.current,
      Math.round(point.x - NODE_W / 2),
      Math.round(point.y - NODE_H / 2),
    )
    const block: Block = {
      id: uid(),
      kind,
      label: BLOCK_META[kind].label,
      x: spot.x,
      y: spot.y,
      config: defaultConfig(kind),
    }
    applyGraph({
      blocks: [...blocksRef.current, block],
      edges: edgesRef.current,
    })
    setSelected([block.id])
    setMode('select')
    modeRef.current = 'select'
    notify(`${block.label} added`)
  }

  function removeBlocks(ids: string[]) {
    if (!ids.length) return
    const nextBlocks = blocksRef.current.filter((block) => !ids.includes(block.id))
    const nextEdges = edgesRef.current.filter(
      (edge) => !ids.includes(edge.fromId) && !ids.includes(edge.toId),
    )
    applyGraph({ blocks: nextBlocks, edges: nextEdges })
    setSelected([])
    notify(
      `${ids.length} block${ids.length > 1 ? 's' : ''} deleted`,
      { label: 'Undo', onClick: undo },
    )
  }

  function duplicateSelected() {
    const originals = blocksRef.current.filter((block) => selectedRef.current.includes(block.id))
    if (!originals.length) return
    const map = new Map<string, string>()
    const placed = [...blocksRef.current]
    const copies = originals.map((block) => {
      const id = uid()
      map.set(block.id, id)
      const spot = freeSpot(placed, block.x + 48, block.y + 48)
      const copy = { ...block, id, label: `${block.label} copy`, x: spot.x, y: spot.y }
      placed.push(copy)
      return copy
    })
    const copiedEdges = edgesRef.current
      .filter((edge) => map.has(edge.fromId) && map.has(edge.toId))
      .map((edge) => ({
        ...edge,
        id: uid(),
        fromId: map.get(edge.fromId)!,
        toId: map.get(edge.toId)!,
      }))
    applyGraph({
      blocks: [...blocksRef.current, ...copies],
      edges: [...edgesRef.current, ...copiedEdges],
    })
    setSelected(copies.map((block) => block.id))
  }

  function clearRejected() {
    window.clearTimeout(rejectTimer.current)
    rejectTimer.current = undefined
    setRejected((current) => (current ? null : current))
  }

  function flashRejected(fromId: string, toId: string) {
    window.clearTimeout(rejectTimer.current)
    setRejected({ fromId, toId })
    rejectTimer.current = window.setTimeout(() => {
      rejectTimer.current = undefined
      setRejected(null)
    }, 1400)
  }

  function connect(fromId: string, toId: string) {
    const from = blocksRef.current.find((block) => block.id === fromId)
    const to = blocksRef.current.find((block) => block.id === toId)
    if (!from || !to) return
    if (edgesRef.current.some((edge) => edge.fromId === fromId && edge.toId === toId)) {
      notify('Those blocks are already connected.')
      return
    }
    const check = canConnect(from, to)
    if (!check.ok) {
      notify(check.error ?? 'Those ports do not match.')
      return
    }
    if (createsCycle(edgesRef.current, fromId, toId)) {
      // Show the offending link itself, not just a banner. Nothing is committed
      // to the graph or the undo stack; the feedback clears on its own timer.
      flashRejected(fromId, toId)
      notify('That connection would create a cycle.')
      return
    }
    clearRejected()
    applyGraph({
      blocks: blocksRef.current,
      edges: [...edgesRef.current, { id: uid(), fromId, toId, port: check.port }],
    })
  }

  // Keystroke edits wait 300 ms before the coalesced commit reaches App, so
  // mirror them to the local draft immediately: a refresh inside that window
  // then recovers the edit instead of dropping it.
  function mirrorWorking(blocks: Block[], edges: Edge[]) {
    mergeDraft(project.id, { graph: { blocks, edges } })
  }

  function updateBlock(id: string, patch: Partial<Block>, commitNow = false) {
    const next = blocksRef.current.map((block) =>
      block.id === id ? { ...block, ...patch } : block,
    )
    if (commitNow) {
      window.clearTimeout(configTimer.current)
      applyGraph({ blocks: next, edges: edgesRef.current })
    } else {
      applyGraph({ blocks: next, edges: edgesRef.current }, true)
      mirrorWorking(next, edgesRef.current)
      scheduleCommit()
    }
  }

  function updateConfig(id: string, patch: Partial<BlockConfig>) {
    const next = blocksRef.current.map((block) =>
      block.id === id ? { ...block, config: { ...block.config, ...patch } } : block,
    )
    applyGraph({ blocks: next, edges: edgesRef.current }, true)
    mirrorWorking(next, edgesRef.current)
    scheduleCommit()
  }

  function fit() {
    const viewport = viewportRef.current
    if (!viewport || blocksRef.current.length === 0) {
      setView({ x: 40, y: 40, k: 1 })
      return
    }
    const minX = Math.min(...blocksRef.current.map((block) => block.x))
    const minY = Math.min(...blocksRef.current.map((block) => block.y))
    const maxX = Math.max(...blocksRef.current.map((block) => block.x + NODE_W))
    const maxY = Math.max(...blocksRef.current.map((block) => block.y + NODE_H))
    const width = Math.max(1, maxX - minX)
    const height = Math.max(1, maxY - minY)
    const rect = viewport.getBoundingClientRect()
    const k = clamp(Math.min((rect.width - 120) / width, (rect.height - 140) / height), 0.2, 1.1)
    setView({
      x: (rect.width - width * k) / 2 - minX * k,
      y: (rect.height - height * k) / 2 - minY * k,
      k,
    })
  }

  function autoLayout() {
    const items = blocksRef.current
    if (!items.length) return
    const depth = new Map<string, number>(items.map((block) => [block.id, 0]))
    const indegree = new Map<string, number>(items.map((block) => [block.id, 0]))
    for (const edge of edgesRef.current) {
      indegree.set(edge.toId, (indegree.get(edge.toId) ?? 0) + 1)
    }
    const queue = items.filter((block) => (indegree.get(block.id) ?? 0) === 0).map((block) => block.id)
    const seen = new Set<string>()
    while (queue.length) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      for (const edge of edgesRef.current) {
        if (edge.fromId !== id) continue
        depth.set(edge.toId, Math.max(depth.get(edge.toId) ?? 0, (depth.get(id) ?? 0) + 1))
        indegree.set(edge.toId, (indegree.get(edge.toId) ?? 1) - 1)
        if ((indegree.get(edge.toId) ?? 0) <= 0) queue.push(edge.toId)
      }
    }
    const columns = new Map<number, Block[]>()
    for (const block of items) {
      const d = depth.get(block.id) ?? 0
      columns.set(d, [...(columns.get(d) ?? []), block])
    }
    const placed = items.map((block) => {
      const d = depth.get(block.id) ?? 0
      const column = columns.get(d) ?? []
      const index = column.findIndex((item) => item.id === block.id)
      return { ...block, x: 60 + d * 280, y: 80 + index * 150 }
    })
    applyGraph({ blocks: placed, edges: edgesRef.current })
    window.setTimeout(fit, 60)
    notify('Graph auto-laid out', { label: 'Undo', onClick: undo })
  }

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const current = viewRef.current
      const rect = viewport.getBoundingClientRect()
      const mx = event.clientX - rect.left
      const my = event.clientY - rect.top
      const nextK = clamp(current.k * Math.exp(-event.deltaY * 0.0012), 0.25, 2.5)
      setView({
        k: nextK,
        x: mx - ((mx - current.x) * nextK) / current.k,
        y: my - ((my - current.y) * nextK) / current.k,
      })
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const isTyping = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
        target.isContentEditable ||
        // Only dialogs capture keys while open. The block palette is a plain
        // list of buttons, so shortcuts must keep working after clicking it.
        Boolean(target.closest('.overlay')))

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return
      if (event.code === 'Space') {
        spaceRef.current = true
        return
      }
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
        return
      }
      if (meta && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        duplicateSelected()
        return
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        if (selectedRef.current.length) {
          event.preventDefault()
          removeBlocks([...selectedRef.current])
        }
        return
      }
      if (event.key === 'Escape') {
        setSelected([])
        setDraft(null)
        setPendingSource(null)
        return
      }
      if (event.key === 'v' || event.key === 'V') {
        setMode('select')
        setPendingSource(null)
        return
      }
      if (event.key === 'c' || event.key === 'C') {
        setMode('connect')
        return
      }
      if (event.key === 'h' || event.key === 'H') {
        setMode('pan')
        setPendingSource(null)
        return
      }
      if (event.key === 'f' || event.key === 'F') {
        fit()
        return
      }
      if (event.key.startsWith('Arrow') && selectedRef.current.length) {
        event.preventDefault()
        const step = event.shiftKey ? 10 : 1
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
        const next = blocksRef.current.map((block) =>
          selectedRef.current.includes(block.id)
            ? { ...block, x: clamp(block.x + dx, -WORLD_LIMIT, WORLD_LIMIT), y: clamp(block.y + dy, -WORLD_LIMIT, WORLD_LIMIT) }
            : block,
        )
        applyGraph({ blocks: next, edges: edgesRef.current })
        return
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceRef.current = false
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    onFocusBlock?.(selected.length === 1 ? selected[0]! : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  useEffect(
    () => () => {
      window.clearTimeout(configTimer.current)
      window.clearTimeout(rejectTimer.current)
    },
    [],
  )

  const estimate = useMemo(
    () => estimateProject(blocks, project.settings),
    [blocks, project.settings],
  )
  const selectedBlocks = blocks.filter((block) => selected.includes(block.id))

  function startNodeDrag(event: ReactPointerEvent, block: Block) {
    if (event.button !== 0) return
    event.stopPropagation()
    if (spaceRef.current || modeRef.current === 'pan') return
    if (modeRef.current === 'connect') {
      if (!pendingSource) {
        setPendingSource(block.id)
        setSelected([block.id])
        notify('Now pick a target block.')
      } else if (pendingSource !== block.id) {
        connect(pendingSource, block.id)
        setPendingSource(null)
      }
      return
    }
    const useIds = selected.includes(block.id) ? selected : event.shiftKey ? [...selected, block.id] : [block.id]
    setSelected(useIds)
    const ids = useIds.includes(block.id) ? useIds : [block.id]
    const origins = new Map(
      blocksRef.current
        .filter((item) => ids.includes(item.id))
        .map((item) => [item.id, { x: item.x, y: item.y }]),
    )
    const start = { x: event.clientX, y: event.clientY }
    let moved = false
    const onMove = (moveEvent: PointerEvent) => {
      const k = viewRef.current.k
      const dx = (moveEvent.clientX - start.x) / k
      const dy = (moveEvent.clientY - start.y) / k
      if (!moved && Math.hypot(dx, dy) < 2) return
      moved = true
      const next = blocksRef.current.map((item) => {
        const origin = origins.get(item.id)
        return origin
          ? {
              ...item,
              x: clamp(origin.x + dx, -WORLD_LIMIT, WORLD_LIMIT),
              y: clamp(origin.y + dy, -WORLD_LIMIT, WORLD_LIMIT),
            }
          : item
      })
      applyGraph({ blocks: next, edges: edgesRef.current }, true)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (moved) commitWorking()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function startConnect(event: ReactPointerEvent, block: Block) {
    if (!BLOCK_META[block.kind].output) return
    event.stopPropagation()
    const start = toWorld(event.clientX, event.clientY)
    setDraft({ fromId: block.id, x: start.x, y: start.y })
    const onMove = (moveEvent: PointerEvent) => {
      const point = toWorld(moveEvent.clientX, moveEvent.clientY)
      setDraft({ fromId: block.id, x: point.x, y: point.y })
    }
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDraft(null)
      const target = document
        .elementFromPoint(upEvent.clientX, upEvent.clientY)
        ?.closest('[data-node-id]')
        ?.getAttribute('data-node-id')
      if (target && target !== block.id) connect(block.id, target)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function startBackground(event: ReactPointerEvent) {
    if (event.button === 2) return
    const panning = spaceRef.current || modeRef.current === 'pan' || event.button === 1
    if (panning) {
      const start = { x: event.clientX, y: event.clientY }
      const origin = { ...viewRef.current }
      const onMove = (moveEvent: PointerEvent) => {
        setView({
          ...origin,
          x: origin.x + (moveEvent.clientX - start.x),
          y: origin.y + (moveEvent.clientY - start.y),
        })
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      return
    }
    if (modeRef.current !== 'select') return
    const start = toWorld(event.clientX, event.clientY)
    setMarquee({ x: start.x, y: start.y, w: 0, h: 0 })
    const onMove = (moveEvent: PointerEvent) => {
      const point = toWorld(moveEvent.clientX, moveEvent.clientY)
      setMarquee({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x),
        h: Math.abs(point.y - start.y),
      })
    }
    const onUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const point = toWorld(upEvent.clientX, upEvent.clientY)
      const box = {
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        w: Math.abs(point.x - start.x),
        h: Math.abs(point.y - start.y),
      }
      setMarquee(null)
      if (box.w < 6 && box.h < 6) {
        setSelected([])
        return
      }
      const hits = blocksRef.current
        .filter(
          (block) =>
            block.x + NODE_W > box.x &&
            block.x < box.x + box.w &&
            block.y + NODE_H > box.y &&
            block.y < box.y + box.h,
        )
        .map((block) => block.id)
      setSelected((previous) => (upEvent.shiftKey ? [...new Set([...previous, ...hits])] : hits))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const gridSize = 24 * view.k
  const viewportStyle = {
    backgroundSize: `${gridSize}px ${gridSize}px`,
    backgroundPosition: `${view.x}px ${view.y}px`,
  }

  if (compact) {
    return (
      <div className="canvas-compact">
        <div className="compact-head">
          <div>
            <span className="eyebrow">Architecture</span>
            <h2 className="mono">
              {formatParams(estimate.params)} params · {formatBytes(estimate.bytesPerGpu)}/GPU
            </h2>
          </div>
          <button className="ghost" onClick={autoLayout}>
            Auto-layout
          </button>
        </div>
        <BlockList
          blocks={blocks}
          edges={edges}
          selected={selected}
          onSelect={(id) => setSelected([id])}
          onRemove={(id) => removeBlocks([id])}
        />
        <div className="compact-add">
          <span className="field-label">Add block</span>
          <div className="palette-inline">
            {BLOCK_KINDS.map((kind) => (
              <button key={kind} onClick={() => addBlock(kind)}>
                {BLOCK_META[kind].label}
              </button>
            ))}
          </div>
        </div>
        {selectedBlocks.length === 1 && (
          <div className="inspector compact-inspector">
            <InspectorBody
              block={selectedBlocks[0]!}
              updateBlock={updateBlock}
              updateConfig={updateConfig}
              remove={() => removeBlocks([selectedBlocks[0]!.id])}
            />
          </div>
        )}
        <RunSettings settings={project.settings} onSettings={onSettings} estimate={estimate} />
      </div>
    )
  }

  return (
    <div className="canvas-view">
      <div className="canvas-toolbar">
        <div className="tool-group">
          {(
            [
              ['select', 'Select', 'V'],
              ['connect', 'Connect', 'C'],
              ['pan', 'Pan', 'H'],
            ] as [Mode, string, string][]
          ).map(([value, label, key]) => (
            <button
              key={value}
              className={`tool${mode === value ? ' on' : ''}`}
              onClick={() => {
                setMode(value)
                setPendingSource(null)
              }}
              title={`${label} (${key})`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="canvas-totals mono">
          <span title="6 × active params × tokens, divided by peak FLOPS × MFU × utilisation">
            {formatParams(estimate.params)} params
          </span>
          <span className="dot-sep">·</span>
          <span>{formatParams(estimate.activeParams)} active</span>
          <span className="dot-sep">·</span>
          <span title="Weights + master/Adam state + activations, divided by shards">
            {formatBytes(estimate.bytesPerGpu)}/GPU
          </span>
          <span className="dot-sep">·</span>
          <span>{formatHours(estimate.gpuHours)}</span>
        </div>
        <div className="canvas-actions">
          <button className="icon-btn" aria-label="Undo" title="Undo (⌘Z)" onClick={undo} disabled={cursor.current <= 0}>
            <Icon name="undo" />
          </button>
          <button
            className="icon-btn"
            aria-label="Redo"
            title="Redo (⇧⌘Z)"
            onClick={redo}
            disabled={cursor.current >= history.current.length - 1}
          >
            <Icon name="redo" />
          </button>
          <button className="icon-btn" aria-label="Fit to view" title="Fit (F)" onClick={fit}>
            <Icon name="fit" />
          </button>
          <button className="icon-btn" aria-label="Auto-layout" title="Auto-layout" onClick={autoLayout}>
            <Icon name="layout" />
          </button>
        </div>
      </div>
      <div className="canvas-body">
        <aside className="palette" aria-label="Block palette">
          <span className="palette-title">Blocks</span>
          {(['input', 'compute', 'output'] as const).map((group) => (
            <div className="palette-group" key={group}>
              <span className="palette-group-label">{group}</span>
              {BLOCK_KINDS.filter((kind) => BLOCK_META[kind].group === group).map((kind) => (
                <button
                  key={kind}
                  className={`palette-item kind-${kind}`}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData('application/x-rack-block', kind)
                    event.dataTransfer.effectAllowed = 'copy'
                  }}
                  onClick={() => addBlock(kind)}
                  title={BLOCK_META[kind].blurb}
                >
                  <span className="palette-code mono">{BLOCK_META[kind].code}</span>
                  {BLOCK_META[kind].label}
                </button>
              ))}
            </div>
          ))}
          <p className="palette-hint">Drag onto the canvas or click to place.</p>
        </aside>

        <div
          className="canvas-viewport"
          ref={viewportRef}
          style={viewportStyle}
          onPointerDown={startBackground}
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={(event) => {
            event.preventDefault()
            const kind = event.dataTransfer.getData('application/x-rack-block') as BlockKind
            if (kind && kind in BLOCK_META) addBlock(kind, toWorld(event.clientX, event.clientY))
          }}
          data-node-id=""
        >
          <div
            className="world"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
          >
            <svg className="edge-layer" width="1" height="1">
              {edges.map((edge) => {
                const from = blocks.find((block) => block.id === edge.fromId)
                const to = blocks.find((block) => block.id === edge.toId)
                if (!from || !to) return null
                return (
                  <path
                    key={edge.id}
                    className="edge"
                    d={edgePath(from, to)}
                    markerEnd="url(#arrow)"
                  />
                )
              })}
              {draft &&
                (() => {
                  const from = blocks.find((block) => block.id === draft.fromId)
                  if (!from) return null
                  return (
                    <path
                      className="edge draft"
                      d={`M${from.x + NODE_W},${from.y + NODE_H / 2} C${from.x + NODE_W + 60},${from.y + NODE_H / 2} ${draft.x - 60},${draft.y} ${draft.x},${draft.y}`}
                    />
                  )
                })()}
              {rejected &&
                (() => {
                  const from = blocks.find((block) => block.id === rejected.fromId)
                  const to = blocks.find((block) => block.id === rejected.toId)
                  if (!from || !to) return null
                  return (
                    <g className="reject-edge">
                      <path
                        className="edge rejected"
                        d={edgePath(from, to)}
                        markerEnd="url(#arrow-risk)"
                      />
                      <circle cx={from.x + NODE_W} cy={from.y + NODE_H / 2} r={3.5} />
                      <circle cx={to.x} cy={to.y + NODE_H / 2} r={3.5} />
                    </g>
                  )
                })()}
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" className="arrow-head" />
                </marker>
                <marker id="arrow-risk" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0,0 L10,5 L0,10 z" className="arrow-head risk" />
                </marker>
              </defs>
            </svg>

            {blocks.map((block) => {
              const meta = BLOCK_META[block.kind]
              const isSelected = selected.includes(block.id)
              const [lineOne, lineTwo] = blockSummary(block)
              return (
                <div
                  key={block.id}
                  className={`node kind-${block.kind}${isSelected ? ' selected' : ''}${
                    pendingSource === block.id ? ' pending' : ''
                  }`}
                  style={{ left: block.x, top: block.y }}
                  data-node-id={block.id}
                  onPointerDown={(event) => startNodeDrag(event, block)}
                  onDoubleClick={() => setSelected([block.id])}
                  role="button"
                  tabIndex={-1}
                  aria-label={`${block.label}, ${meta.label}`}
                >
                  {meta.input.length > 0 && (
                    <span
                      className="port in"
                      title={`Input: ${meta.input.join(' / ')}`}
                      data-input-port={block.id}
                      onPointerDown={(event) => event.stopPropagation()}
                    />
                  )}
                  <span className="node-code mono">{meta.code}</span>
                  <strong className="node-title">{block.label}</strong>
                  <span className="node-line mono">{lineOne}</span>
                  <span className="node-line mono">{lineTwo}</span>
                  <span className="node-params mono">
                    {formatParams(blockParams(block.kind, block.config))} ·{' '}
                    {formatBytes(trainingBytes(block.kind, block.config))}
                  </span>
                  {meta.output && (
                    <span
                      className="port out"
                      title={`Output: ${meta.output}`}
                      onPointerDown={(event) => startConnect(event, block)}
                    />
                  )}
                </div>
              )
            })}

            {marquee && (
              <div
                className="marquee"
                style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
              />
            )}
          </div>

          {blocks.length === 0 && (
            <div className="canvas-empty">
              <span className="empty-mark">⌗</span>
              <h3>Nothing mapped yet</h3>
              <p>Add a block from the left, or drop one here, to start the graph.</p>
            </div>
          )}

          <Minimap blocks={blocks} view={view} viewportRef={viewportRef} setView={setView} />

          <div className="canvas-hints mono">
            <span>drag ports to connect</span>
            <span>⌘Z undo</span>
            <span>F fit</span>
            <span>? shortcuts</span>
          </div>
        </div>

        <aside className="inspector" aria-label="Inspector">
          {selectedBlocks.length === 0 && (
            <RunSettings settings={project.settings} onSettings={onSettings} estimate={estimate} />
          )}
          {selectedBlocks.length === 1 && (
            <InspectorBody
              block={selectedBlocks[0]!}
              updateBlock={updateBlock}
              updateConfig={updateConfig}
              remove={() => removeBlocks([selectedBlocks[0]!.id])}
            />
          )}
          {selectedBlocks.length > 1 && (
            <div className="inspector-body">
              <span className="eyebrow">Selection</span>
              <h3 className="mono">{selectedBlocks.length} blocks</h3>
              <p className="muted">
                {formatParams(
                  selectedBlocks.reduce(
                    (sum, block) => sum + blockParams(block.kind, block.config),
                    0,
                  ),
                )}{' '}
                parameters across the selection.
              </p>
              <button className="ghost danger-text" onClick={() => removeBlocks([...selected])}>
                <Icon name="trash" /> Delete selection
              </button>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function edgePath(from: Block, to: Block): string {
  const x1 = from.x + NODE_W
  const y1 = from.y + NODE_H / 2
  const x2 = to.x
  const y2 = to.y + NODE_H / 2
  // Cards in the seed layouts sit close together, so any gap at or right of the
  // source port is a normal forward link: keep its curve inside that gap.
  if (x2 - x1 > -8) {
    const bend = Math.min(120, Math.max(10, (x2 - x1) * 0.6))
    return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
  }
  // A backward link loops around the right of both blocks instead of cutting a
  // wide S back across the graph.
  const lane = Math.max(x1, x2 + NODE_W) + 30
  const flat = Math.abs(y2 - y1) < 32
  const bow = flat ? Math.min(from.y, to.y) - 34 : y1
  const tail = flat ? Math.min(from.y, to.y) - 34 : y2
  return `M${x1},${y1} C${lane},${bow} ${lane},${tail} ${x2},${y2}`
}

function overlapsAt(blocks: Block[], x: number, y: number) {
  return blocks.some(
    (block) =>
      Math.abs(block.x - x) < NODE_W + 24 && Math.abs(block.y - y) < NODE_H + 24,
  )
}

/** Nearest free slot: the point itself, then rings below, above, right, left. */
function freeSpot(blocks: Block[], x: number, y: number) {
  const stepX = NODE_W + 28
  const stepY = NODE_H + 28
  for (let ring = 0; ring <= 8; ring += 1) {
    const offsets = ring === 0 ? [[0, 0]] : [[0, 1], [0, -1], [1, 0], [-1, 0]]
    for (const [dx, dy] of offsets) {
      const spot = { x: x + dx * ring * stepX, y: y + dy * ring * stepY }
      if (!overlapsAt(blocks, spot.x, spot.y)) return spot
    }
  }
  return { x: x + 9 * stepX, y }
}

/** Separate blocks saved on the exact same pixel, which reads as one block. */
function separateOverlaps(blocks: Block[]): Block[] {
  const placed: Block[] = []
  let changed = false
  for (const block of blocks) {
    if (!placed.some((item) => item.x === block.x && item.y === block.y)) {
      placed.push(block)
      continue
    }
    changed = true
    placed.push({ ...block, ...freeSpot(placed, block.x, block.y) })
  }
  return changed ? placed : blocks
}

function Minimap({
  blocks,
  view,
  viewportRef,
  setView,
}: {
  blocks: Block[]
  view: View
  viewportRef: RefObject<HTMLDivElement | null>
  setView: (view: View) => void
}) {
  if (!blocks.length) return null
  const minX = Math.min(...blocks.map((block) => block.x))
  const minY = Math.min(...blocks.map((block) => block.y))
  const maxX = Math.max(...blocks.map((block) => block.x + NODE_W))
  const maxY = Math.max(...blocks.map((block) => block.y + NODE_H))
  const width = 156
  const height = 104
  const scale = Math.min(width / Math.max(1, maxX - minX), height / Math.max(1, maxY - minY))
  return (
    <button
      className="minimap"
      aria-label="Minimap"
      onClick={() => {
        const rect = viewportRef.current?.getBoundingClientRect()
        if (!rect) return
        const k = 0.9
        setView({
          k,
          x: rect.width / 2 - ((minX + maxX) / 2) * k,
          y: rect.height / 2 - ((minY + maxY) / 2) * k,
        })
      }}
    >
      <svg width={width} height={height}>
        {blocks.map((block) => (
          <rect
            key={block.id}
            x={(block.x - minX) * scale + 2}
            y={(block.y - minY) * scale + 2}
            width={Math.max(3, NODE_W * scale)}
            height={Math.max(2.5, NODE_H * scale)}
            rx={1.5}
            className={`mini kind-${block.kind}`}
          />
        ))}
        <rect
          x={-view.x / view.k * scale + 2}
          y={-view.y / view.k * scale + 2}
          width={(viewportRef.current?.clientWidth ?? 0) / view.k * scale}
          height={(viewportRef.current?.clientHeight ?? 0) / view.k * scale}
          className="mini-view"
        />
      </svg>
      <span className="minimap-label mono">map</span>
    </button>
  )
}

function InspectorBody({
  block,
  updateBlock,
  updateConfig,
  remove,
}: {
  block: Block
  updateBlock: (id: string, patch: Partial<Block>, commitNow?: boolean) => void
  updateConfig: (id: string, patch: Partial<BlockConfig>) => void
  remove: () => void
}) {
  const meta = BLOCK_META[block.kind]
  const show = (field: 'ffn' | 'experts' | 'vocab' | 'heads' | 'layers') => {
    if (field === 'ffn') return block.kind === 'ffn' || block.kind === 'moe'
    if (field === 'experts') return block.kind === 'moe'
    if (field === 'vocab') return block.kind === 'embedding' || block.kind === 'projection'
    if (field === 'heads') return block.kind === 'attention'
    return block.kind !== 'loss' && block.kind !== 'residual' && block.kind !== 'custom'
  }
  return (
    <div className="inspector-body">
      <div className="inspector-head">
        <span className={`kind-chip kind-${block.kind}`}>{meta.code}</span>
        <span className="eyebrow">{meta.label}</span>
      </div>
      <input
        className="inspector-title"
        value={block.label}
        aria-label="Block label"
        maxLength={60}
        onChange={(event) => updateBlock(block.id, { label: event.target.value })}
        onBlur={() => updateBlock(block.id, { label: block.label }, true)}
      />
      <p className="muted tiny">{meta.blurb}</p>

      <div className="inspector-grid">
        <Field label="d_model">
          <NumberInput value={block.config.dModel} min={16} max={32768} step={128} onChange={(dModel) => updateConfig(block.id, { dModel })} />
        </Field>
        {show('layers') && (
          <Field label="Layers">
            <NumberInput value={block.config.layers} min={0} max={200} onChange={(layers) => updateConfig(block.id, { layers })} />
          </Field>
        )}
        {show('heads') && (
          <>
            <Field label="Heads">
              <NumberInput value={block.config.heads} min={1} max={512} onChange={(heads) => updateConfig(block.id, { heads })} />
            </Field>
            <Field label="KV heads" hint="GQA">
              <NumberInput
                value={block.config.kvHeads}
                min={1}
                max={block.config.heads}
                onChange={(kvHeads) => updateConfig(block.id, { kvHeads })}
              />
            </Field>
          </>
        )}
        {show('ffn') && (
          <Field label="FFN width">
            <NumberInput value={block.config.ffnWidth} min={0} max={262144} step={256} onChange={(ffnWidth) => updateConfig(block.id, { ffnWidth })} />
          </Field>
        )}
        {show('experts') && (
          <>
            <Field label="Experts">
              <NumberInput value={block.config.experts} min={1} max={256} onChange={(experts) => updateConfig(block.id, { experts })} />
            </Field>
            <Field label="Top-k">
              <NumberInput value={block.config.topK} min={1} max={block.config.experts} onChange={(topK) => updateConfig(block.id, { topK })} />
            </Field>
          </>
        )}
        {show('vocab') && (
          <Field label="Vocab">
            <NumberInput value={block.config.vocab} min={256} max={1_000_000} step={1000} onChange={(vocab) => updateConfig(block.id, { vocab })} />
          </Field>
        )}
        <Field label="Seq length">
          <NumberInput value={block.config.seqLen} min={128} max={2_000_000} step={1024} onChange={(seqLen) => updateConfig(block.id, { seqLen })} />
        </Field>
        <Field label="Batch">
          <NumberInput value={block.config.batch} min={1} max={8192} onChange={(batch) => updateConfig(block.id, { batch })} />
        </Field>
      </div>

      <Field label="Precision">
        <Segmented<Precision>
          label="Precision"
          value={block.config.precision}
          options={PRECISIONS.map((precision) => ({ value: precision, label: precision }))}
          onChange={(precision) => updateConfig(block.id, { precision })}
        />
      </Field>

      <div className="inspector-math">
        <div>
          <span>Block parameters</span>
          <strong className="mono">{formatParams(blockParams(block.kind, block.config))}</strong>
        </div>
        <div>
          <span>Training bytes</span>
          <strong className="mono">
            {formatBytes(trainingBytes(block.kind, block.config))}
          </strong>
        </div>
      </div>

      <button className="ghost danger-text" onClick={remove}>
        <Icon name="trash" /> Delete block
      </button>
    </div>
  )
}

function RunSettings({
  settings,
  onSettings,
  estimate,
}: {
  settings: ProjectSettings
  onSettings: (settings: ProjectSettings) => void
  estimate: ReturnType<typeof estimateProject>
}) {
  return (
    <div className="inspector-body">
      <span className="eyebrow">Run settings</span>
      <h3 className="mono">{formatParams(estimate.params)} total params</h3>
      <p className="muted tiny">
        Estimates update live. Select a block to edit its dimensions; these
        settings drive the training run.
      </p>
      <div className="inspector-grid">
        <Field label="Tokens" hint="billions">
          <NumberInput value={settings.tokensB} min={0} max={100_000} step={100} onChange={(tokensB) => onSettings({ ...settings, tokensB })} />
        </Field>
        <Field label="MFU" hint="%">
          <NumberInput value={settings.mfu} min={1} max={90} onChange={(mfu) => onSettings({ ...settings, mfu })} />
        </Field>
        <Field label="Shards" hint="GPUs">
          <NumberInput value={settings.shards} min={1} max={4096} onChange={(shards) => onSettings({ ...settings, shards })} />
        </Field>
      </div>
      <Field label="Accelerator">
        <select
          className="input"
          value={settings.accelerator}
          onChange={(event) =>
            onSettings({ ...settings, accelerator: event.target.value as ProjectSettings['accelerator'] })
          }
        >
          {Object.entries(ACCELERATORS).map(([key, value]) => (
            <option key={key} value={key}>
              {value.label} · ${value.rate}/h
            </option>
          ))}
        </select>
      </Field>
      <div className="inspector-math stacked">
        <div>
          <span title="6 × active params × tokens">Training FLOPs</span>
          <strong className="mono">{estimate.flops > 0 ? `${(estimate.flops / 1e21).toFixed(2)} ZFLOP` : '—'}</strong>
        </div>
        <div>
          <span title="weights + optimizer state + activations, ÷ shards">Memory / GPU</span>
          <strong className="mono">{formatBytes(estimate.bytesPerGpu)}</strong>
        </div>
        <div>
          <span title="FLOPs ÷ (peak × MFU × 0.4 utilisation) ÷ 3600">GPU hours</span>
          <strong className="mono">{formatHours(estimate.gpuHours)}</strong>
        </div>
        <div>
          <span>Compute cost</span>
          <strong className="mono">{formatMoney(estimate.computeCost)}</strong>
        </div>
      </div>
      <p className="formula muted tiny">
        params ≈ emb + layers·d²·(2+2·kv/heads) + layers·2·d·ffn + experts; memory
        adds 8 bytes of master/Adam state per parameter; compute ≈ 6·N·D.
      </p>
    </div>
  )
}

function BlockList({
  blocks,
  edges,
  selected,
  onSelect,
  onRemove,
}: {
  blocks: Block[]
  edges: Edge[]
  selected: string[]
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}) {
  const depth = new Map<string, number>()
  for (const block of blocks) depth.set(block.id, 0)
  for (let pass = 0; pass < blocks.length; pass += 1) {
    for (const edge of edges) {
      const next = (depth.get(edge.fromId) ?? 0) + 1
      if ((depth.get(edge.toId) ?? 0) < next) depth.set(edge.toId, next)
    }
  }
  const ordered = [...blocks].sort(
    (a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.y - b.y,
  )
  return (
    <ol className="block-list">
      {ordered.map((block) => (
        <li
          key={block.id}
          className={selected.includes(block.id) ? 'on' : ''}
          style={{ paddingLeft: 12 + (depth.get(block.id) ?? 0) * 18 }}
        >
          <button className="block-list-main" onClick={() => onSelect(block.id)}>
            <span className={`kind-chip kind-${block.kind}`}>{BLOCK_META[block.kind].code}</span>
            <span>{block.label}</span>
            <span className="mono muted">{formatParams(blockParams(block.kind, block.config))}</span>
          </button>
          <button className="icon-btn small" aria-label="Delete block" onClick={() => onRemove(block.id)}>
            <Icon name="trash" size={12} />
          </button>
        </li>
      ))}
    </ol>
  )
}
