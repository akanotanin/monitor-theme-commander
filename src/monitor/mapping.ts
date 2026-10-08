import type { MonitorNode } from './types'
import type { RPC2NodeData, RPC2NodeStatus } from '@/lib/rpc2/types'
import { getRegionEnglishName } from '@/data/regionCoords'

/**
 * 把极简探针（Monitor）的节点映射成主题读取的 Komari 结构。
 *
 * 字段口径与 Komari 官方前端一致（komari-web：net.in = Download、net.out = Upload）：
 * - `net_in` ← 探针 `net_rx`（下行速率），`net_out` ← `net_tx`（上行速率）
 * - `net_total_up` / `net_total_down` ← 本计费周期上行 / 下行（流量条与配额同一口径）
 * - `connections` = TCP + UDP 总数，`connections_udp` = UDP（主题侧会拆分出 TCP）
 */

/** 计费周期文案与 Komari 的天数表示互转（主题按天数估算月均费用） */
const BILLING_CYCLE_DAYS: Record<string, number> = {
  monthly: 30,
  quarterly: 90,
  semiannual: 180,
  'semi-annual': 180,
  semi_annual: 180,
  half_yearly: 180,
  yearly: 365,
  annual: 365,
  biennial: 730,
  triennial: 1095,
  quinquennial: 1825,
  once: -1,
}

/** Komari 的 traffic_limit_type 只认识这几种取值，其余一律按 sum 处理 */
const TRAFFIC_MODES = new Set(['sum', 'max', 'min', 'up', 'down'])

/** 计费周期文案转天数，未知文案返回 0（主题按自定义周期处理） */
export function billingCycleDays(cycle: string | null | undefined): number {
  if (!cycle) return 0
  return BILLING_CYCLE_DAYS[cycle.trim().toLowerCase()] ?? 0
}

/** ISO 3166-1 alpha-2 国家代码转旗帜 emoji；无法识别时返回空串 */
function flagEmoji(code: string | null | undefined): string {
  const cc = (code ?? '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(cc)) return ''
  return String.fromCodePoint(...[...cc].map(c => 0x1f1e6 + c.charCodeAt(0) - 65))
}

/** 浮点安全：Hub 未提供的字段保持 undefined，图表会画成空档而不是 0 */
function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把 Monitor 节点映射成 Komari 的 Client + NodeStatus
 * 主题的组件全部按 Komari 结构读取，因此映射后无需改动
 */
export function mapNode(node: MonitorNode): { client: RPC2NodeData, status: RPC2NodeStatus } {
  const m = node.online ? node.metrics : null
  const uuid = String(node.id)
  const load = Array.isArray(m?.load) ? m.load : []
  const emoji = flagEmoji(node.country)
  const regionName = emoji ? getRegionEnglishName(emoji) : ''
  const monthUp = m?.month_tx ?? node.month_tx ?? 0
  const monthDown = m?.month_rx ?? node.month_rx ?? 0
  const tcp = finite(m?.tcp) ?? 0
  const udp = finite(m?.udp) ?? 0

  const client: RPC2NodeData = {
    uuid,
    name: node.name,
    cpu_name: node.cpu_name || '',
    virtualization: node.virt || '',
    arch: node.arch || '',
    cpu_cores: node.cpu_cores || 0,
    os: node.os || '',
    kernel_version: node.kernel || '',
    // 极简探针公开接口不提供 GPU 型号与 IP
    gpu_name: '',
    ipv4: '',
    ipv6: '',
    // Komari 的 region 是「旗帜 emoji + 地区名」，世界地图与地区筛选都从 emoji 解析
    region: emoji ? (regionName ? `${emoji} ${regionName}` : emoji) : '',
    remark: node.remark ?? '',
    public_remark: node.public_remark ?? '',
    mem_total: node.mem_total || 0,
    swap_total: node.swap_total || 0,
    disk_total: node.disk_total || 0,
    weight: node.sort ?? 0,
    price: node.price ?? 0,
    billing_cycle: billingCycleDays(node.billing_cycle),
    auto_renewal: false,
    currency: node.currency || 'CNY',
    expired_at: node.expires_at ?? '',
    expires_in: node.expires_in ?? null,
    group: node.group ?? '',
    // 极简探针公开接口不提供标签
    tags: '',
    hidden: false,
    traffic_limit: node.traffic_limit ?? 0,
    traffic_limit_type: (TRAFFIC_MODES.has(node.traffic_mode) ? node.traffic_mode : 'sum') as RPC2NodeData['traffic_limit_type'],
    created_at: '',
    updated_at: '',
  }

  const status: RPC2NodeStatus = {
    client: uuid,
    time: node.last_seen ? new Date(node.last_seen * 1000).toISOString() : new Date().toISOString(),
    cpu: finite(m?.cpu) ?? 0,
    gpu: 0,
    ram: finite(m?.mem_used) ?? 0,
    ram_total: m?.mem_total ?? node.mem_total ?? 0,
    swap: finite(m?.swap_used) ?? 0,
    swap_total: m?.swap_total ?? node.swap_total ?? 0,
    load: finite(load[0]) ?? 0,
    load5: finite(load[1]) ?? 0,
    load15: finite(load[2]) ?? 0,
    // 极简探针不上报温度
    temp: 0,
    disk: finite(m?.disk_used) ?? 0,
    disk_total: m?.disk_total ?? node.disk_total ?? 0,
    net_in: finite(m?.net_rx) ?? 0,
    net_out: finite(m?.net_tx) ?? 0,
    // 主题的流量条与配额按「本计费周期」统计，与 Hub 的流量上限同一口径
    net_total_up: monthUp,
    net_total_down: monthDown,
    process: finite(m?.procs) ?? 0,
    connections: tcp + udp,
    connections_udp: udp,
    online: Boolean(node.online),
    uptime: finite(m?.uptime) ?? 0,
  }

  return { client, status }
}
