import { describe, expect, it } from 'vitest';
import { mapNode } from './mapping';
import type { MonitorNode } from './types';

/**
 * 映射层是移植的语义边界：这里把「Komari 字段 ← 极简探针字段」的口径钉死，
 * 特别是网络方向（net_in = 下行 / net_out = 上行，与 komari-web 官方口径一致）。
 */

function node(patch: Partial<MonitorNode> = {}): MonitorNode {
  return {
    id: 7,
    name: '节点·测试',
    sort: 3,
    group: '东京',
    public: true,
    online: true,
    country: 'JP',
    last_seen: 1700000000,
    os: 'Debian GNU/Linux 12 (bookworm)',
    kernel: '6.1.0-53-amd64',
    arch: 'x86_64',
    virt: 'kvm',
    cpu_name: 'Intel Core Processor',
    cpu_cores: 2,
    mem_total: 3079503872,
    swap_total: 1073737728,
    disk_total: 21097524736,
    agent_version: '1.2.0',
    price: 30,
    currency: 'CNY',
    billing_cycle: 'monthly',
    expires_at: '2026-11-06',
    expires_in: 28,
    traffic_limit: 2199023255552,
    traffic_mode: 'sum',
    traffic_reset_day: 1,
    total_rx: 9958985435,
    total_tx: 1569675380,
    month_rx: 2016725540,
    month_tx: 854001193,
    month_start: '2026-10-01',
    day_rx: 2002228,
    day_tx: 712175,
    metrics: {
      uptime: 764714,
      cpu: 0.9,
      load: [0.1, 0.2, 0.3],
      mem_total: 3079503872,
      mem_used: 467550208,
      swap_total: 1073737728,
      swap_used: 0,
      disk_total: 21097524736,
      disk_used: 4414490112,
      net_rx: 3772,
      net_tx: 3315,
      total_rx: 9958985435,
      total_tx: 1569675380,
      month_rx: 2016725540,
      month_tx: 854001193,
      tcp: 55,
      udp: 12,
      procs: 103,
    },
    ...patch,
  };
}

describe('mapNode', () => {
  it('网络方向与官方口径一致：net_in = 下行（rx），net_out = 上行（tx）', () => {
    const { status } = mapNode(node());
    expect(status.net_in).toBe(3772);
    expect(status.net_out).toBe(3315);
  });

  it('周期流量用于配额口径：net_total_up/down = 本计费周期上行/下行', () => {
    const { status } = mapNode(node());
    expect(status.net_total_up).toBe(854001193);
    expect(status.net_total_down).toBe(2016725540);
  });

  it('连接数按 Komari 约定：connections = TCP+UDP 总数，connections_udp = UDP', () => {
    const { status } = mapNode(node());
    expect(status.connections).toBe(67);
    expect(status.connections_udp).toBe(12);
  });

  it('计费周期文案转天数，到期天数透传 expires_in', () => {
    const { client } = mapNode(node());
    expect(client.billing_cycle).toBe(30);
    expect(client.expires_in).toBe(28);
    expect(client.expired_at).toBe('2026-11-06');
  });

  it('国家代码转「旗帜 emoji + 英文地区名」，无法识别时留空', () => {
    expect(mapNode(node()).client.region).toBe('🇯🇵 Japan');
    expect(mapNode(node({ country: '' })).client.region).toBe('');
  });

  it('极简探针没有的字段不伪造：gpu/温度/标签留空或 0，负载按三档展开', () => {
    const { client, status } = mapNode(node());
    expect(client.gpu_name).toBe('');
    expect(client.tags).toBe('');
    expect(status.temp).toBe(0);
    expect(status.load).toBe(0.1);
    expect(status.load5).toBe(0.2);
    expect(status.load15).toBe(0.3);
  });

  it('离线节点：metrics 为 null 时全部读数归零、online 保持 false', () => {
    const { status } = mapNode(node({ online: false, metrics: null }));
    expect(status.online).toBe(false);
    expect(status.cpu).toBe(0);
    expect(status.net_in).toBe(0);
  });

  it('未知计费周期返回 0（主题按自定义周期处理）', () => {
    const { client } = mapNode(node({ billing_cycle: '每两年半' }));
    expect(client.billing_cycle).toBe(0);
  });
});
