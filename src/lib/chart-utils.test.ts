import { describe, expect, it } from 'vitest';
import { buildPingSparkline, type PingRecord, type TaskInfo } from './chart-utils';

const t0 = Date.parse('2026-10-09T00:00:00Z');
const rec = (task: number, minute: number, value: number): PingRecord => ({
  client: 'demo',
  task_id: task,
  time: new Date(t0 + minute * 60_000).toISOString(),
  value,
});

describe('buildPingSparkline', () => {
  it('picks the lowest-average task and returns its series', () => {
    const tasks: TaskInfo[] = [
      { id: 1, name: 'A', interval: 60, avg: 80 },
      { id: 2, name: 'B', interval: 60, avg: 30 },
    ];
    const records = [rec(1, 0, 82), rec(1, 1, 78), rec(2, 0, 30), rec(2, 1, 33), rec(2, 2, 27)];
    const built = buildPingSparkline(records, tasks, 1);
    expect(built).not.toBeNull();
    expect(built!.values).toEqual([30, 33, 27]);
    expect(built!.latest).toBe(27);
  });

  it('treats packet loss (negative values) as a gap and interpolates it away', () => {
    const tasks: TaskInfo[] = [{ id: 7, name: 'CN2', interval: 60, avg: 40 }];
    const records = [rec(7, 0, 30), rec(7, 1, -1), rec(7, 2, 50)];
    const built = buildPingSparkline(records, tasks, 1);
    expect(built).not.toBeNull();
    expect(built!.values).toEqual([30, 40, 50]);
  });

  it('returns null without usable data', () => {
    expect(buildPingSparkline([], [], 1)).toBeNull();
    expect(buildPingSparkline([rec(1, 0, 20)], [], 1)).toBeNull();
  });
});
