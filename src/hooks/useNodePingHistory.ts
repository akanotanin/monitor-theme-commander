import { useEffect, useState } from 'react';
import { apiService } from '@/services/api';
import { buildPingSparkline, pickPingLine, type PingRecord, type TaskInfo } from '@/lib/chart-utils';
import { useAppConfig } from '@/hooks/useAppConfig';

/** 侧栏延迟曲线：默认取最近一小时里最优线路（平均延迟最低）的序列；
 *  主题设置「Ping 延迟线路」填了任务名时，改取该线路。 */
export function useNodePingHistory(uuid: string, enabled: boolean) {
  const [series, setSeries] = useState<number[] | null>(null);
  const { themeConfig } = useAppConfig();
  const preferredLine = pickPingLine(themeConfig.ping_lines);

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
              preferredLine,
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
  }, [uuid, enabled, preferredLine]);

  return series;
}
