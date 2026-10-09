import { useEffect, useState } from 'react';
import { apiService } from '@/services/api';
import { buildPingSparkline, type PingRecord, type TaskInfo } from '@/lib/chart-utils';

/** 侧栏延迟曲线：取最近一小时里最优线路（平均延迟最低）的延迟序列。 */
export function useNodePingHistory(uuid: string, enabled: boolean) {
  const [series, setSeries] = useState<number[] | null>(null);

  useEffect(() => {
    if (!enabled || !uuid) {
      setSeries(null);
      return;
    }
    setSeries(null);
    let alive = true;
    apiService
      .getPingHistory(uuid, 1)
      .then((history) => {
        if (!alive) return;
        const built = history
          ? buildPingSparkline(
              (history.records || []) as PingRecord[],
              (history.tasks || []) as TaskInfo[],
              1,
            )
          : null;
        setSeries(built?.values ?? null);
      })
      .catch(() => {
        if (alive) setSeries(null);
      });
    return () => {
      alive = false;
    };
  }, [uuid, enabled]);

  return series;
}
