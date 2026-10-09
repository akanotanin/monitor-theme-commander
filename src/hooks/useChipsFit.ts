import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 单行芯片行的自适应：隐形量宽行按实测宽度算出放得下几枚，
 * 放不下的在真行里折进「+N」悬浮层。
 *
 * 用法：真行渲染 `items.slice(0, fitCount)`，紧挨着再渲染一条
 * `invisible absolute` 的同内容量宽行（挂 measureRef，不参与布局）；
 * 每个芯片外包一层 `span[data-chip-key]`。
 */
export function useChipsFit() {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [fitCount, setFitCount] = useState(Number.POSITIVE_INFINITY);

  const recompute = useCallback(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if (!row || !measure) return;
    const avail = row.clientWidth;
    if (avail <= 0) return;
    const widths = [...measure.querySelectorAll<HTMLElement>('[data-chip-key]')].map(el => el.getBoundingClientRect().width);
    const gap = parseFloat(getComputedStyle(row).columnGap) || 4; // 真行的实际间距
    const nChip = 34; // 「+N」芯片预留宽度
    let used = 0;
    let fit = 0;
    for (let i = 0; i < widths.length; i++) {
      const need = used + (i > 0 ? gap : 0) + widths[i];
      if (need <= avail) {
        used = need;
        fit = i + 1;
      } else break;
    }
    if (fit < widths.length) {
      while (fit > 0) {
        let total = 0;
        for (let i = 0; i < fit; i++) total += widths[i] + (i > 0 ? gap : 0);
        if (total + gap + nChip <= avail) break;
        fit -= 1;
      }
    }
    setFitCount(fit);
  }, []);

  useLayoutEffect(() => {
    recompute();
  });

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const observer = new ResizeObserver(() => recompute());
    observer.observe(row);
    return () => observer.disconnect();
  }, [recompute]);

  return { rowRef, measureRef, fitCount };
}
