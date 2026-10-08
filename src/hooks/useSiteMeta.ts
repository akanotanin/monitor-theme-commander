import { useState, useEffect } from 'react';
import { apiService } from '@/services/api';

/** 站点名兜底：Hub 未设置站名（site_name 为空）或接口不可用时显示 */
const FALLBACK_SITE_NAME = 'Monitor';

export function useSiteMeta() {
  const [siteName, setSiteName] = useState(FALLBACK_SITE_NAME);
  const [siteDescription, setSiteDescription] = useState('');
  const [version, setVersion] = useState('');
  const [customBody, setCustomBody] = useState<string>('');

  useEffect(() => {
    const init = async () => {
      try {
        const [publicSettings, versionInfo] = await Promise.all([
          apiService.getPublicSettings(),
          apiService.getVersion(),
        ]);
        if (publicSettings?.sitename) {
          const name = publicSettings.sitename as string;
          setSiteName(name);
          // 标签页标题跟随站点名（数据未到之前保持 index.html 的静态标题）
          document.title = name;
        }
        if (publicSettings?.description) setSiteDescription(publicSettings.description as string);
        if (publicSettings?.custom_body) setCustomBody(publicSettings.custom_body as string);
        if (versionInfo?.version) setVersion(versionInfo.version);
      } catch {
        /* keep defaults when public API is unreachable */
      }
    };
    init();
  }, []);

  return { siteName, siteDescription, version, customBody };
}
