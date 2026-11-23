import type {
  Block,
  BlockConfig,
  BlockKind,
  Edge,
  Eval,
  EvalStatus,
  PlanPayload,
  PortType,
  Precision,
  Project,
  ProjectSettings,
  ProjectStage,
  ProjectSummary,
  Role,
  Stage,
} from '../shared/types'
import { DEFAULT_SETTINGS, estimateProject } from '../shared/estimate'

/*
 * Child rows are owned by a project, so their key is (project_id, id).
 * A client-generated id (block, edge, stage, role or eval) must be able to
 * repeat across projects; a global primary key would let one project's ids
 * block another project's save with a constraint error.
 */
const childTables = {
  blocks: {
    columns: ['id', 'project_id', 'kind', 'label', 'x', 'y', 'config'],
    create: `CREATE TABLE IF NOT EXISTS blocks (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      config TEXT NOT NULL,
      PRIMARY KEY (project_id, id)
    )`,
    index: `CREATE INDEX IF NOT EXISTS blocks_project ON blocks(project_id)`,
  },
  edges: {
    columns: ['id', 'project_id', 'from_id', 'to_id', 'port'],
    create: `CREATE TABLE IF NOT EXISTS edges (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      port TEXT NOT NULL,
      PRIMARY KEY (project_id, id)
    )`,
    index: `CREATE INDEX IF NOT EXISTS edges_project ON edges(project_id)`,
  },
  stages: {
    columns: [
      'id',
      'project_id',
      'name',
      'position',
      'start_week',
      'end_week',
      'owner_role',
      'compute_note',
      'depends_on',
    ],
    create: `CREATE TABLE IF NOT EXISTS stages (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      start_week INTEGER NOT NULL,
      end_week INTEGER NOT NULL,
      owner_role TEXT NOT NULL,
      compute_note TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      PRIMARY KEY (project_id, id)
    )`,
    index: `CREATE INDEX IF NOT EXISTS stages_project ON stages(project_id, position)`,
  },
  roles: {
    columns: ['id', 'project_id', 'name', 'headcount', 'rate', 'allocation'],
    create: `CREATE TABLE IF NOT EXISTS roles (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      headcount INTEGER NOT NULL,
      rate REAL NOT NULL,
      allocation TEXT NOT NULL,
      PRIMARY KEY (project_id, id)
    )`,
    index: `CREATE INDEX IF NOT EXISTS roles_project ON roles(project_id)`,
  },
  evals: {
    columns: ['id', 'project_id', 'name', 'metric', 'target', 'cadence', 'gate_stage', 'status'],
    create: `CREATE TABLE IF NOT EXISTS evals (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      metric TEXT NOT NULL,
      target TEXT NOT NULL,
      cadence TEXT NOT NULL,
      gate_stage TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (project_id, id)
    )`,
    index: `CREATE INDEX IF NOT EXISTS evals_project ON evals(project_id)`,
  },
} as const

const schema = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    owner_sub TEXT NOT NULL,
    name TEXT NOT NULL,
    brief TEXT NOT NULL,
    stage TEXT NOT NULL,
    start_date INTEGER NOT NULL,
    settings TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS projects_owner_updated ON projects(owner_sub, updated_at DESC, id)`,
  ...Object.values(childTables).flatMap((table) => [table.create, table.index]),
]

/** Rebuild child tables created before ids were scoped to their project. */
async function upgradeChildKeys(db: D1Database): Promise<void> {
  const existing = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'blocks'")
    .first<{ sql: string | null }>()
  if (!existing?.sql || /PRIMARY KEY\s*\(\s*project_id\s*,\s*id\s*\)/i.test(existing.sql)) return
  const statements: D1PreparedStatement[] = Object.keys(childTables).map((name) =>
    db.prepare(`DROP INDEX IF EXISTS ${name}_project`),
  )
  for (const [name, table] of Object.entries(childTables)) {
    const legacy = `${name}_legacy`
    statements.push(db.prepare(`ALTER TABLE ${name} RENAME TO ${legacy}`))
    statements.push(db.prepare(table.create.replace('IF NOT EXISTS ', '')))
    statements.push(
      db.prepare(
        `INSERT INTO ${name} (${table.columns.join(', ')}) SELECT ${table.columns.join(', ')} FROM ${legacy}`,
      ),
    )
    statements.push(db.prepare(`DROP TABLE ${legacy}`))
    statements.push(db.prepare(table.index))
  }
  await db.batch(statements)
}

const ready = new WeakMap<D1Database, Promise<void>>()
export function ensureSchema(db: D1Database): Promise<void> {
  let pending = ready.get(db)
  if (!pending) {
    pending = db
      .batch(schema.map((sql) => db.prepare(sql)))
      .then(() => upgradeChildKeys(db))
      .catch((error) => {
        ready.delete(db)
        throw error
      })
    ready.set(db, pending)
  }
  return pending
}

type ProjectRow = {
  id: string
  name: string
  brief: string
  stage: string
  start_date: number
  settings: string
  created_at: number
  updated_at: number
}
type BlockRow = {
  id: string
  kind: string
  label: string
  x: number
  y: number
  config: string
}
type EdgeRow = { id: string; from_id: string; to_id: string; port: string }
type StageRow = {
  id: string
  name: string
  position: number
  start_week: number
  end_week: number
  owner_role: string
  compute_note: string
  depends_on: string
}
type RoleRow = {
  id: string
  name: string
  headcount: number
  rate: number
  allocation: string
}
type EvalRow = {
  id: string
  name: string
  metric: string
  target: string
  cadence: string
  gate_stage: string
  status: string
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === 'object' ? (value as T) : fallback
  } catch {
    return fallback
  }
}

export async function listProjects(
  db: D1Database,
  owner: string,
): Promise<ProjectSummary[]> {
  const rows = await db
    .prepare(
      'SELECT id, name, brief, stage, start_date, settings, created_at, updated_at FROM projects WHERE owner_sub = ? ORDER BY updated_at DESC, id LIMIT 100',
    )
    .bind(owner)
    .all<ProjectRow>()
  const now = Date.now()
  const summaries: ProjectSummary[] = []
  for (const row of rows.results) {
    const project = await loadProject(db, row.id, owner)
    if (!project) continue
    const estimate = estimateProject(project.blocks, project.settings)
    const ordered = [...project.stages].sort((a, b) => a.position - b.position)
    const upcoming = ordered
      .map((stage) => project.startDate + stage.endWeek * 7 * 86_400_000)
      .filter((date) => date > now)
      .sort((a, b) => a - b)
    summaries.push({
      id: project.id,
      name: project.name,
      brief: project.brief,
      stage: project.stage,
      startDate: project.startDate,
      updatedAt: project.updatedAt,
      params: estimate.params,
      teamSize: project.roles.reduce((sum, role) => sum + role.headcount, 0),
      nextMilestone: upcoming[0] ?? null,
      progress: ordered.map((stage) => {
        const start = project.startDate + stage.startWeek * 7 * 86_400_000
        const end = project.startDate + stage.endWeek * 7 * 86_400_000
        if (now >= end) return 1
        if (now <= start) return 0
        return (now - start) / Math.max(1, end - start)
      }),
    })
  }
  return summaries
}

export async function loadProject(
  db: D1Database,
  id: string,
  owner: string,
): Promise<Project | null> {
  const row = await db
    .prepare(
      'SELECT id, name, brief, stage, start_date, settings, created_at, updated_at FROM projects WHERE id = ? AND owner_sub = ?',
    )
    .bind(id, owner)
    .first<ProjectRow>()
  if (!row) return null
  const [blockRows, edgeRows, stageRows, roleRows, evalRows] = await Promise.all([
    db.prepare('SELECT id, kind, label, x, y, config FROM blocks WHERE project_id = ?').bind(id).all<BlockRow>(),
    db.prepare('SELECT id, from_id, to_id, port FROM edges WHERE project_id = ?').bind(id).all<EdgeRow>(),
    db.prepare('SELECT id, name, position, start_week, end_week, owner_role, compute_note, depends_on FROM stages WHERE project_id = ? ORDER BY position, id').bind(id).all<StageRow>(),
    db.prepare('SELECT id, name, headcount, rate, allocation FROM roles WHERE project_id = ?').bind(id).all<RoleRow>(),
    db.prepare('SELECT id, name, metric, target, cadence, gate_stage, status FROM evals WHERE project_id = ?').bind(id).all<EvalRow>(),
  ])
  const settings = { ...DEFAULT_SETTINGS, ...parseJson<ProjectSettings>(row.settings, DEFAULT_SETTINGS) }
  return {
    id: row.id,
    name: row.name,
    brief: row.brief,
    stage: row.stage as ProjectStage,
    startDate: row.start_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settings,
    blocks: blockRows.results.map(
      (block): Block => ({
        id: block.id,
        kind: block.kind as BlockKind,
        label: block.label,
        x: block.x,
        y: block.y,
        config: parseJson<BlockConfig>(block.config, {} as BlockConfig),
      }),
    ),
    edges: edgeRows.results.map(
      (edge): Edge => ({
        id: edge.id,
        fromId: edge.from_id,
        toId: edge.to_id,
        port: edge.port as PortType,
      }),
    ),
    stages: stageRows.results.map(
      (stage): Stage => ({
        id: stage.id,
        name: stage.name,
        position: stage.position,
        startWeek: stage.start_week,
        endWeek: stage.end_week,
        ownerRole: stage.owner_role,
        computeNote: stage.compute_note,
        dependsOn: parseJson<string[]>(stage.depends_on, []),
      }),
    ),
    roles: roleRows.results.map(
      (role): Role => ({
        id: role.id,
        name: role.name,
        headcount: role.headcount,
        rate: role.rate,
        allocation: parseJson<Record<string, number>>(role.allocation, {}),
      }),
    ),
    evals: evalRows.results.map(
      (item): Eval => ({
        id: item.id,
        name: item.name,
        metric: item.metric,
        target: item.target,
        cadence: item.cadence,
        gateStage: item.gate_stage,
        status: item.status as EvalStatus,
      }),
    ),
  }
}

export type ProjectInput = {
  name: string
  brief: string
  stage: ProjectStage
  startDate: number
  settings: ProjectSettings
  blocks: Block[]
  edges: Edge[]
  stages: Stage[]
  roles: Role[]
  evals: Eval[]
}

export async function insertProject(
  db: D1Database,
  owner: string,
  input: ProjectInput,
): Promise<string> {
  const now = Date.now()
  const id = crypto.randomUUID()
  const statements = [
    db
      .prepare(
        'INSERT INTO projects (id, owner_sub, name, brief, stage, start_date, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        owner,
        input.name,
        input.brief,
        input.stage,
        input.startDate,
        JSON.stringify(input.settings),
        now,
        now,
      ),
    ...input.blocks.map((block) =>
      db
        .prepare('INSERT INTO blocks (id, project_id, kind, label, x, y, config) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(block.id, id, block.kind, block.label, block.x, block.y, JSON.stringify(block.config)),
    ),
    ...input.edges.map((edge) =>
      db
        .prepare('INSERT INTO edges (id, project_id, from_id, to_id, port) VALUES (?, ?, ?, ?, ?)')
        .bind(edge.id, id, edge.fromId, edge.toId, edge.port),
    ),
    ...input.stages.map((stage) =>
      db
        .prepare(
          'INSERT INTO stages (id, project_id, name, position, start_week, end_week, owner_role, compute_note, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          stage.id,
          id,
          stage.name,
          stage.position,
          stage.startWeek,
          stage.endWeek,
          stage.ownerRole,
          stage.computeNote,
          JSON.stringify(stage.dependsOn),
        ),
    ),
    ...input.roles.map((role) =>
      db
        .prepare('INSERT INTO roles (id, project_id, name, headcount, rate, allocation) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(role.id, id, role.name, role.headcount, role.rate, JSON.stringify(role.allocation)),
    ),
    ...input.evals.map((item) =>
      db
        .prepare(
          'INSERT INTO evals (id, project_id, name, metric, target, cadence, gate_stage, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(item.id, id, item.name, item.metric, item.target, item.cadence, item.gateStage, item.status),
    ),
  ]
  await db.batch(statements)
  return id
}

async function owns(
  db: D1Database,
  projectId: string,
  owner: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM projects WHERE id = ? AND owner_sub = ?')
    .bind(projectId, owner)
    .first()
  return Boolean(row)
}

export async function touch(
  db: D1Database,
  projectId: string,
  owner: string,
): Promise<boolean> {
  const row = await db
    .prepare('UPDATE projects SET updated_at = ? WHERE id = ? AND owner_sub = ? RETURNING id')
    .bind(Date.now(), projectId, owner)
    .first()
  return Boolean(row)
}

export async function replaceGraph(
  db: D1Database,
  projectId: string,
  owner: string,
  blocks: Block[],
  edges: Edge[],
): Promise<boolean> {
  if (!(await owns(db, projectId, owner))) return false
  await db.batch([
    db.prepare('DELETE FROM edges WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM blocks WHERE project_id = ?').bind(projectId),
    ...blocks.map((block) =>
      db
        .prepare('INSERT INTO blocks (id, project_id, kind, label, x, y, config) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(block.id, projectId, block.kind, block.label, block.x, block.y, JSON.stringify(block.config)),
    ),
    ...edges.map((edge) =>
      db
        .prepare('INSERT INTO edges (id, project_id, from_id, to_id, port) VALUES (?, ?, ?, ?, ?)')
        .bind(edge.id, projectId, edge.fromId, edge.toId, edge.port),
    ),
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ? AND owner_sub = ?').bind(Date.now(), projectId, owner),
  ])
  return true
}

export async function replacePlan(
  db: D1Database,
  projectId: string,
  owner: string,
  plan: PlanPayload,
): Promise<boolean> {
  if (!(await owns(db, projectId, owner))) return false
  await db.batch([
    db.prepare('DELETE FROM stages WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM roles WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM evals WHERE project_id = ?').bind(projectId),
    ...plan.stages.map((stage) =>
      db
        .prepare(
          'INSERT INTO stages (id, project_id, name, position, start_week, end_week, owner_role, compute_note, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          stage.id,
          projectId,
          stage.name,
          stage.position,
          stage.startWeek,
          stage.endWeek,
          stage.ownerRole,
          stage.computeNote,
          JSON.stringify(stage.dependsOn),
        ),
    ),
    ...plan.roles.map((role) =>
      db
        .prepare('INSERT INTO roles (id, project_id, name, headcount, rate, allocation) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(role.id, projectId, role.name, role.headcount, role.rate, JSON.stringify(role.allocation)),
    ),
    ...plan.evals.map((item) =>
      db
        .prepare(
          'INSERT INTO evals (id, project_id, name, metric, target, cadence, gate_stage, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(item.id, projectId, item.name, item.metric, item.target, item.cadence, item.gateStage, item.status),
    ),
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ? AND owner_sub = ?').bind(Date.now(), projectId, owner),
  ])
  return true
}

export async function deleteProject(
  db: D1Database,
  projectId: string,
  owner: string,
): Promise<boolean> {
  if (!(await owns(db, projectId, owner))) return false
  await db.batch([
    db.prepare('DELETE FROM blocks WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM edges WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM stages WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM roles WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM evals WHERE project_id = ?').bind(projectId),
    db.prepare('DELETE FROM projects WHERE id = ? AND owner_sub = ?').bind(projectId, owner),
  ])
  return true
}

export async function patchProject(
  db: D1Database,
  projectId: string,
  owner: string,
  patch: { name: string; brief: string; stage: ProjectStage; startDate: number },
): Promise<Project | null> {
  const row = await db
    .prepare(
      'UPDATE projects SET name = ?, brief = ?, stage = ?, start_date = ?, updated_at = ? WHERE id = ? AND owner_sub = ? RETURNING id',
    )
    .bind(patch.name, patch.brief, patch.stage, patch.startDate, Date.now(), projectId, owner)
    .first()
  return row ? loadProject(db, projectId, owner) : null
}
