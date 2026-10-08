import type { HistoryWindow, MonitorFrame, MonitorNode, PingPoint, SiteInfo } from './types'
import type {
  RPC2NodeStatus,
  RPC2PingRecord,
  RPC2PingStat,
  RPC2PingTask,
  RPC2StatusRecord,
} from '@/lib/rpc2/types'
import { mapNode } from './mapping'
import themeManifest from '../../theme.json'

/**
 * 极简探针传输层
 * 把 Monitor 的 REST / WebSocket 接口翻译成主题原本依赖的 Komari RPC2 数据
 */

/** 与 vite 的 VITE_API_BASE 保持一致，开发时由 dev server 代理到 MONITOR_HUB */
const API_BASE = (import.meta.env.VITE_API_BASE || '/api').replace(/\/$/, '')

/** 主题包名，用于拼配置接口路径（与 theme.json 的 short 同源） */
export const THEME_SHORT = themeManifest.short

/** 无实时连接时的节点快照缓存，避免同一帧内重复请求 */
const SNAPSHOT_TTL = 1500
/** 实时连接健康时快照有效期（Hub 的 /api/ws 约每 2 秒推一帧） */
const WS_FRESH_TTL = 6000
/** 历史窗口缓存：图表按固定档位轮询，粒度不会比 1 分钟更细 */
const HISTORY_TTL = 15000
/** 匿名访客与管理员各自能看到的历史窗口（小时） */
const PUBLIC_HOURS = 168
const ADMIN_HOURS = 2160
/** 单节点延迟统计的缓存时长（延迟采样约每分钟一次） */
const PING_TTL = 60000

let snapshot: MonitorNode[] = []
let admin = false
let received = 0
let pending: Promise<MonitorNode[]> | undefined
let liveUp = false
const historyCache = new Map<string, { time: number, promise: Promise<HistoryWindow> }>()
const pingCache = new Map<string, { at: number, stats: Record<string, RPC2PingStat> }>()
const pingPending = new Set<string>()

export class MonitorRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'MonitorRequestError'
    this.status = status
  }
}

/** 请求极简探针接口；站点未开放状态页时跳到后台登录 */
export async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(15000)
  const response = await fetch(`${API_BASE}${path}`, {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (response.status === 401) {
    location.assign('/admin/')
    throw new MonitorRequestError(401, '需要登录极简探针后台')
  }
  if (!response.ok)
    throw new MonitorRequestError(response.status, `极简探针接口 ${path} 返回 ${response.status}`)
  return await response.json() as T
}

/** 记录一帧节点快照（来自 /api/nodes 或 /api/ws） */
export function acceptFrame(frame: Partial<MonitorFrame> | null | undefined): MonitorNode[] {
  if (!frame || !Array.isArray(frame.nodes))
    throw new MonitorRequestError(0, '无效的节点快照')
  snapshot = frame.nodes
  admin = Boolean(frame.admin)
  received = Date.now()
  return frame.nodes
}

/** 最近一次快照的时间戳（毫秒），供「数据是否新鲜」判断 */
export function lastSnapshotAt(): number {
  return received
}

/** 实时连接是否处于打开状态 */
export function liveConnected(): boolean {
  return liveUp
}

/** 读取节点列表（实时连接健康时用推送帧，否则回落到 HTTP 快照缓存） */
export async function readNodes(): Promise<MonitorNode[]> {
  const ttl = liveUp ? WS_FRESH_TTL : SNAPSHOT_TTL
  if (Date.now() - received < ttl)
    return snapshot
  pending ??= request<MonitorFrame>('/nodes')
    .then(frame => acceptFrame(frame))
    .finally(() => { pending = undefined })
  return pending
}

/** 强制刷新节点快照（重连后调用） */
export function refreshNodes(): Promise<MonitorNode[]> {
  received = 0
  return readNodes()
}

/** 当前访客是否为已登录管理员（由 /api/nodes 的 admin 字段给出） */
export function isAdmin(): boolean {
  return admin
}

/** 历史窗口上限（小时），供主题的图表选择器使用 */
export function preserveHours(): number {
  return admin ? ADMIN_HOURS : PUBLIC_HOURS
}

/** 把节点列表映射成 Komari 的 clients / statuses 字典 */
export function mappedNodes(nodes: MonitorNode[]) {
  const entries = nodes.map(mapNode)
  return {
    clients: Object.fromEntries(entries.map(n => [n.client.uuid, n.client])),
    statuses: Object.fromEntries(entries.map(n => [n.client.uuid, n.status])),
  }
}

let siteCache: { at: number, info: SiteInfo } | undefined

/** 站点名称与登录状态 */
export async function site(): Promise<SiteInfo> {
  if (siteCache && Date.now() - siteCache.at < 30000)
    return siteCache.info
  const info = await request<SiteInfo>('/me')
  siteCache = { at: Date.now(), info }
  return info
}

let configCache: { at: number, data: Record<string, unknown> } | undefined

/** 读取 Hub 上保存的主题配置（匿名可读；未保存过或读取失败时为空对象） */
export async function loadThemeConfig(): Promise<Record<string, unknown>> {
  if (configCache && Date.now() - configCache.at < 5000)
    return configCache.data
  try {
    const saved = await request<Record<string, unknown>>(`/themes/${THEME_SHORT}/config`)
    const data = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
    configCache = { at: Date.now(), data }
    return data
  }
  catch (error) {
    console.warn('[theme] 读取主题配置失败，改用默认值', error)
    return {}
  }
}

/**
 * 历史窗口：Monitor 按 hours + points 自动分桶
 * points 决定桶宽，1 分钟一个采样是 Hub 能给出的最细粒度
 */
async function history(id: string, hours: number, series: 'metrics' | 'ping', points = 600): Promise<HistoryWindow> {
  if (!/^\d+$/.test(id))
    throw new MonitorRequestError(0, '无效的节点编号')
  const path = `/nodes/${id}/metrics?${new URLSearchParams({ hours: String(hours), points: String(points), series })}`
  const cached = historyCache.get(path)
  if (cached && Date.now() - cached.time < HISTORY_TTL)
    return await cached.promise
  const promise = request<HistoryWindow>(path).catch((error) => {
    historyCache.delete(path)
    throw error
  })
  if (historyCache.size > 100)
    historyCache.clear()
  historyCache.set(path, { time: Date.now(), promise })
  return await promise
}

/** 限制并发，避免一个放大的图表把 Hub 的连接池占满 */
async function mapLimited<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      output[index] = await worker(items[index]!)
    }
  }))
  return output
}

/** 窗口点数：短窗口按分钟取点，长窗口最多 600 点 */
function windowPoints(hours: number): number {
  return Math.max(60, Math.min(600, Math.round(hours * 60)))
}

function toIso(ts: number): string {
  return new Date(ts * 1000).toISOString()
}

/**
 * 一条历史负载记录。
 * Monitor 的历史只保留 cpu / 内存 / 磁盘 / 网络，swap、负载、连接数、进程数
 * 这类字段没有历史序列 —— 这里刻意不补 0，让图表画成空档而不是贴着 0 的假线。
 */
function loadRecord(node: MonitorNode, point: HistoryWindow['metrics'][number]): RPC2StatusRecord {
  return {
    client: String(node.id),
    time: toIso(point.ts),
    cpu: point.cpu,
    ram: point.mem_used,
    ram_total: node.metrics?.mem_total ?? node.mem_total,
    disk: point.disk_used,
    disk_total: node.metrics?.disk_total ?? node.disk_total,
    net_in: point.net_rx,
    net_out: point.net_tx,
  } as unknown as RPC2StatusRecord
}

/** 把 ping 序列按探测线路分组，统计有限值 */
function groupPingByTask(points: PingPoint[]) {
  const values = new Map<number, number[]>()
  const latest = new Map<number, number>()
  const total = new Map<number, number>()
  for (const point of points) {
    total.set(point.task_id, (total.get(point.task_id) ?? 0) + 1)
    if (typeof point.latency === 'number' && Number.isFinite(point.latency)) {
      let list = values.get(point.task_id)
      if (!list) {
        list = []
        values.set(point.task_id, list)
      }
      list.push(point.latency)
      latest.set(point.task_id, point.latency)
    }
  }
  return { values, latest, total }
}

function percentile(sorted: number[], ratio: number): number {
  if (!sorted.length)
    return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index]!
}

/** 窗口内的丢包率（%）：优先用 Hub 给的 loss，缺失时按超时样本自行计算 */
function lossPercent(taskId: number, h: HistoryWindow, total: number, ok: number): number {
  const fromHub = h.loss?.[String(taskId)]
  if (typeof fromHub === 'number' && Number.isFinite(fromHub))
    return fromHub
  if (!total)
    return 0
  return Math.round(((total - ok) / total) * 10000) / 100
}

/** 把 1 小时的 ping 窗口聚合成主题卡片使用的延迟统计（每条探测线路一份） */
function pingStatsFromWindow(h: HistoryWindow): Record<string, RPC2PingStat> {
  const { values, latest, total } = groupPingByTask(h.ping)
  const stats: Record<string, RPC2PingStat> = {}
  for (const [id, name] of Object.entries(h.probes)) {
    const taskId = Number(id)
    const list = values.get(taskId)
    if (!list?.length)
      continue
    const sorted = [...list].sort((a, b) => a - b)
    const sum = list.reduce((acc, value) => acc + value, 0)
    stats[id] = {
      name,
      latest: latest.get(taskId) ?? -1,
      avg: Math.round((sum / list.length) * 100) / 100,
      tail: percentile(sorted, 0.95),
      loss: lossPercent(taskId, h, total.get(taskId) ?? 0, list.length),
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
    }
  }
  return stats
}

/** 后台预热节点的延迟统计（不阻塞当前请求，下一帧自然带上） */
function ensurePingStats(nodes: MonitorNode[]): void {
  const now = Date.now()
  for (const node of nodes) {
    if (!node.online)
      continue
    const id = String(node.id)
    if (pingPending.has(id))
      continue
    const cached = pingCache.get(id)
    if (cached && now - cached.at < PING_TTL)
      continue
    pingPending.add(id)
    void history(id, 1, 'ping', 60)
      .then(h => pingCache.set(id, { at: Date.now(), stats: pingStatsFromWindow(h) }))
      .catch(() => { /* 单个节点的延迟拿不到时忽略 */ })
      .finally(() => pingPending.delete(id))
  }
}

/**
 * 历史记录，兼容主题用到的两种入口
 * - 负载：records 以节点 uuid 为键（common:getRecords type=load）
 * - 延迟：records 为平铺数组 + tasks（common:getRecords type=ping）
 */
export async function records(params: Record<string, unknown>, ping = false) {
  const nodes = await readNodes()
  const wanted = params.uuid ? nodes.filter(n => String(n.id) === String(params.uuid)) : nodes
  const hours = Number(params.hours ?? 1) || 1
  const points = windowPoints(hours)

  if (ping) {
    const allRecords: RPC2PingRecord[] = []
    const tasks = new Map<number, RPC2PingTask>()
    let from = ''
    let to = ''

    await mapLimited(wanted, async (node) => {
      const h = await history(String(node.id), hours, 'ping', points)
      for (const point of h.ping) {
        allRecords.push({
          client: String(node.id),
          task_id: point.task_id,
          time: toIso(point.ts),
          // 负值表示超时，与 Komari 的约定一致
          value: typeof point.latency === 'number' && Number.isFinite(point.latency) ? point.latency : -1,
        })
      }
      const { values, latest, total } = groupPingByTask(h.ping)
      for (const [id, name] of Object.entries(h.probes)) {
        const taskId = Number(id)
        const list = values.get(taskId)
        if (!list?.length)
          continue
        const sorted = [...list].sort((a, b) => a - b)
        const sum = list.reduce((acc, value) => acc + value, 0)
        const previous = tasks.get(taskId)
        tasks.set(taskId, {
          id: taskId,
          name,
          interval: 60,
          loss: lossPercent(taskId, h, total.get(taskId) ?? 0, list.length),
          type: 'icmp',
          avg: Math.round((sum / list.length) * 100) / 100,
          latest: latest.get(taskId) ?? -1,
          min: sorted[0],
          max: sorted[sorted.length - 1],
          p50: percentile(sorted, 0.5),
          p99: percentile(sorted, 0.99),
          total: (previous?.total ?? 0) + list.length,
        })
      }
      const first = h.ping[0]
      const last = h.ping[h.ping.length - 1]
      if (first && !from)
        from = toIso(first.ts)
      if (last)
        to = toIso(last.ts)
    })

    return { count: allRecords.length, records: allRecords, tasks: [...tasks.values()], basic_info: [], from, to }
  }

  const keyed: Record<string, RPC2StatusRecord[]> = {}
  let count = 0
  let from = ''
  let to = ''

  await mapLimited(wanted, async (node) => {
    const h = await history(String(node.id), hours, 'metrics', points)
    const list = h.metrics.map(point => loadRecord(node, point))
    keyed[String(node.id)] = list
    count += list.length
    if (list.length) {
      if (!from)
        from = list[0]!.time
      to = list[list.length - 1]!.time
    }
  })

  return { count, records: keyed, from, to }
}

/** 最近 1 小时的状态记录（实时图表用），并把 Hub 当前采样追加在末位 */
async function recentStatus(nodeId: string) {
  const nodes = await readNodes()
  const node = nodes.find(n => String(n.id) === nodeId)
  if (!node)
    return { count: 0, records: [] as RPC2StatusRecord[] }
  const h = await history(nodeId, 1, 'metrics', 60)
  const list = h.metrics.map(point => loadRecord(node, point))
  const live = node.online ? node.metrics : null
  if (live) {
    const current: RPC2StatusRecord = {
      client: nodeId,
      time: new Date().toISOString(),
      cpu: live.cpu,
      gpu: 0,
      ram: live.mem_used,
      ram_total: live.mem_total,
      swap: live.swap_used,
      swap_total: live.swap_total,
      load: live.load?.[0] ?? 0,
      load5: live.load?.[1] ?? 0,
      load15: live.load?.[2] ?? 0,
      temp: 0,
      disk: live.disk_used,
      disk_total: live.disk_total,
      net_in: live.net_rx,
      net_out: live.net_tx,
      net_total_up: live.month_tx,
      net_total_down: live.month_rx,
      process: live.procs,
      connections: (live.tcp ?? 0) + (live.udp ?? 0),
      connections_udp: live.udp ?? 0,
      uptime: live.uptime,
      message: '',
    }
    const last = list[list.length - 1]
    // 同一个时间桶内不重复追加，避免出现两条时间相同的点
    if (!last || Date.parse(last.time) < Date.parse(current.time) - 1000)
      list.push(current)
    else
      list[list.length - 1] = current
  }
  return { count: list.length, records: list }
}

/** 站点公开信息 + 主题配置（主题的 useAppConfig / useSiteMeta 都从这里取） */
async function publicInfo(): Promise<Record<string, unknown>> {
  const [me, config] = await Promise.all([site(), loadThemeConfig()])
  const historyDays = typeof me.history_days === 'number' && me.history_days > 0 ? me.history_days : 30
  return {
    sitename: me.site_name || '',
    description: '',
    custom_body: '',
    theme_settings: config,
    // Hub 保留历史的天数即图表可回溯的上限
    record_preserve_time: historyDays * 24,
    ping_record_preserve_time: historyDays * 24,
  }
}

/**
 * 把 Komari RPC2 方法名翻译成极简探针接口调用
 * 极简探针不提供的能力抛错，主题侧会显示为「不支持」而不是假数据
 */
export async function dispatch(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  switch (method) {
    case 'rpc.ping':
      await readNodes()
      return 'pong'
    case 'common:getNodes':
      return mappedNodes(await readNodes()).clients
    case 'common:getNodesLatestStatus': {
      const nodes = await readNodes()
      const { statuses } = mappedNodes(nodes)
      ensurePingStats(nodes)
      for (const node of nodes) {
        const cached = pingCache.get(String(node.id))
        if (cached && node.online)
          (statuses[String(node.id)] as RPC2NodeStatus).ping = cached.stats
      }
      if (params.uuid)
        return { [String(params.uuid)]: statuses[String(params.uuid)] }
      if (Array.isArray(params.uuids)) {
        const picked: Record<string, RPC2NodeStatus | undefined> = {}
        for (const uuid of params.uuids)
          picked[String(uuid)] = statuses[String(uuid)]
        return picked
      }
      return statuses
    }
    case 'common:getNodeRecentStatus':
      return await recentStatus(String(params.uuid ?? ''))
    case 'common:getRecords':
      return await records(params, params.type === 'ping')
    case 'public:getPingRecords':
      return await records(params, true)
    case 'common:getPublicInfo':
    case 'public:getPublicSettings':
      return await publicInfo()
    case 'public:listMetricDefinitions':
      // 极简探针不暴露逐指标保留策略，返回空表让主题回落到 record_preserve_time
      return []
    case 'common:getVersion': {
      // 版本接口只对管理员开放，匿名访客留空，页脚会隐藏这一项
      if (!admin)
        return { version: '', hash: '' }
      try {
        const info = await request<Record<string, unknown>>('/version')
        return {
          version: typeof info?.version === 'string' ? info.version : '',
          hash: typeof info?.hash === 'string' ? info.hash : '',
        }
      }
      catch {
        return { version: '', hash: '' }
      }
    }
    case 'common:getMe': {
      const me = await site()
      return { logged_in: me.authed, username: '', uuid: '', '2fa_enabled': false, sso_id: '', sso_type: '' }
    }
    default:
      throw new MonitorRequestError(0, `极简探针不提供此能力：${method}`)
  }
}

/** 实时连接状态 */
export type LiveState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting'

export interface LiveHandle {
  close: () => void
}

export interface LiveOptions {
  /** 每一帧节点快照（transport 层已同时写入快照缓存） */
  onNodes?: (nodes: MonitorNode[]) => void
  onState: (state: LiveState) => void
  /** WebSocket 实例的建立 / 关闭（供状态栏读取 readyState） */
  onSocket?: (socket: WebSocket | null) => void
  retryInterval?: number
  maxRetries?: number
}

/**
 * 订阅 /api/ws 的节点快照（Hub 约每 2 秒推一帧）
 * 连接失败会自动重连；主题侧另有 HTTP 轮询兜底，因此这里不做无限重试
 */
export function connectLive(options: LiveOptions): LiveHandle {
  // 非浏览器环境（单元测试 / SSR）：不做连接，静默保持断开状态
  if (typeof location === 'undefined' || typeof WebSocket === 'undefined') {
    options.onState('disconnected')
    return { close() { /* noop */ } }
  }

  const retryInterval = options.retryInterval ?? 3000
  const maxRetries = options.maxRetries ?? 5
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  let closed = false

  const url = new URL(`${API_BASE}/ws`, location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'

  const scheduleRetry = () => {
    if (closed)
      return
    if (attempts >= maxRetries) {
      liveUp = false
      options.onState('disconnected')
      return
    }
    attempts += 1
    options.onState('reconnecting')
    timer = setTimeout(connect, retryInterval)
  }

  function connect(): void {
    if (closed)
      return
    options.onState('connecting')
    try {
      socket = new WebSocket(url)
    }
    catch {
      scheduleRetry()
      return
    }
    options.onSocket?.(socket)
    socket.onopen = () => {
      attempts = 0
      liveUp = true
      options.onState('connected')
    }
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string) as MonitorFrame
        if (Array.isArray(frame?.nodes)) {
          acceptFrame(frame)
          options.onNodes?.(frame.nodes)
        }
      }
      catch {
        // 忽略无法解析的帧
      }
    }
    socket.onerror = () => {
      liveUp = false
      options.onState('reconnecting')
    }
    socket.onclose = () => {
      liveUp = false
      socket = null
      options.onSocket?.(null)
      if (!closed)
        scheduleRetry()
    }
  }

  connect()

  return {
    close() {
      closed = true
      liveUp = false
      if (timer)
        clearTimeout(timer)
      timer = null
      if (socket) {
        socket.onopen = null
        socket.onmessage = null
        socket.onerror = null
        socket.onclose = null
        socket.close()
        socket = null
        options.onSocket?.(null)
      }
    },
  }
}
