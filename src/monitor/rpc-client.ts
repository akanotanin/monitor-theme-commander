import { RPC2ConnectionState } from '@/lib/rpc2/types'
import type { RPC2CallOptions, RPC2ConnectionStateType, RPC2EventListeners } from '@/lib/rpc2/types'
import { connectLive, dispatch, lastSnapshotAt, refreshNodes, type LiveHandle } from './transport'

/**
 * 极简探针版 RPC2 客户端
 *
 * 主题的全部数据调用都经过这里：`call()` 把 Komari RPC2 方法名交给传输层翻译成
 * Monitor REST 调用；实时通道则连接 Hub 的 /api/ws（约每 2 秒推一帧节点快照）。
 * 对外保留原 RPC2Client 的公开形状（state / ws / reconnect / setEventListeners），
 * 组件与 services 层因此一行不用改。
 */

/** 数据仍然新鲜的判定窗口：实时连接断开但 HTTP 轮询在跑时，状态栏依旧显示 LIVE */
const LIVE_FRESHNESS_MS = 10000

export class MonitorRPC2Client {
  private live: LiveHandle | null = null
  private liveState: RPC2ConnectionStateType = RPC2ConnectionState.DISCONNECTED
  private socket: WebSocket | null = null
  private listeners: RPC2EventListeners = {}

  constructor() {
    // 与原实现一致：构造即开始连接，不阻塞应用启动
    this.start()
  }

  /** Get current connection state */
  get state(): RPC2ConnectionStateType {
    if (this.socket && this.socket.readyState === WebSocket.OPEN)
      return RPC2ConnectionState.CONNECTED
    // 实时连接不可用时，只要还有新鲜数据（HTTP 轮询兜底）就仍视为在线
    if (lastSnapshotAt() > 0 && Date.now() - lastSnapshotAt() < LIVE_FRESHNESS_MS)
      return RPC2ConnectionState.CONNECTED
    return this.liveState
  }

  /** Get internal WebSocket instance (for WebSocketStatus component compatibility) */
  get ws(): WebSocket | null {
    return this.socket
  }

  /** Set event listeners */
  setEventListeners(listeners: RPC2EventListeners): void {
    this.listeners = { ...this.listeners, ...listeners }
  }

  /** Establish the live connection */
  async connect(): Promise<void> {
    this.start()
  }

  /** Disconnect the live connection */
  disconnect(): void {
    this.live?.close()
    this.live = null
    this.socket = null
    this.liveState = RPC2ConnectionState.DISCONNECTED
  }

  /** Reset and reconnect — used by the offline status button */
  reconnect(): void {
    this.disconnect()
    this.liveState = RPC2ConnectionState.RECONNECTING
    this.start()
    void refreshNodes().catch(() => { /* 下一次轮询会再试 */ })
  }

  private start(): void {
    if (this.live)
      return
    this.liveState = RPC2ConnectionState.CONNECTING
    this.live = connectLive({
      onState: (state) => {
        switch (state) {
          case 'connected':
            this.liveState = RPC2ConnectionState.CONNECTED
            this.listeners.onConnect?.()
            break
          case 'reconnecting':
            this.liveState = RPC2ConnectionState.RECONNECTING
            this.listeners.onReconnecting?.(0)
            break
          case 'connecting':
            this.liveState = RPC2ConnectionState.CONNECTING
            break
          default:
            this.liveState = RPC2ConnectionState.DISCONNECTED
            this.listeners.onDisconnect?.()
            break
        }
      },
      onSocket: (socket) => {
        this.socket = socket
      },
      retryInterval: 3000,
      maxRetries: 5,
    })
  }

  /** Call RPC method — translated to Monitor REST by the transport layer */
  async call<TParams = unknown, TResult = unknown>(
    method: string,
    params?: TParams,
    options?: RPC2CallOptions,
  ): Promise<TResult> {
    // 保留 options 形参以兼容原 RPC2Client 的调用形状（当前实现不需要超时覆盖）
    void options;
    return await dispatch(method, (params ?? {}) as Record<string, unknown>) as TResult
  }

  /** Batch call — resolved independently through the same dispatch */
  async batchCall(requests: Array<{ method: string, params?: unknown, notification?: boolean }>): Promise<unknown[]> {
    return await Promise.all(requests.map(request => dispatch(request.method, (request.params ?? {}) as Record<string, unknown>)))
  }
}
