import { cn, extractRegionEmoji, regionEmojiToCode } from '@/lib/utils';

/**
 * FlagBadge — 由 region 字符串（「旗帜 emoji + 名称」或单独 emoji）渲染包内 SVG 国旗。
 *
 * 为什么不用 emoji 本身：Windows 的 Segoe UI Emoji 不含旗帜字形，🇯🇵 会渲染成
 * 两个字母「JP」，🇩🇪 → 「DE」。所以所有展示旗帜的位置统一走这个组件，
 * 用 flag-icons 的 /flags/4x3/*.svg 图片（随包分发，离线可用）。
 *
 * `.fi` 的宽高由 font-size 驱动（宽 = 4/3 × 高），size 即旗帜高度（px）。
 */
export function FlagBadge({
  region,
  size = 14,
  className,
}: {
  region?: string | null;
  /** 旗帜高度（px）；宽度按 4:3 自动计算 */
  size?: number;
  className?: string;
}) {
  const code = regionEmojiToCode(extractRegionEmoji(region ?? ''));
  if (!code) return null;

  return (
    <span
      aria-hidden
      className={cn(
        'fi shrink-0 rounded-[3px] ring-1 ring-border/40',
        `fi-${code.toLowerCase()}`,
        className,
      )}
      style={{ fontSize: `${size}px` }}
    />
  );
}
