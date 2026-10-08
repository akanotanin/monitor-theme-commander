import { extractRegionEmoji, extractRegionText, getRegionDisplayName, regionEmojiToCode, cn } from '@/lib/utils';
import { FlagBadge } from './FlagBadge';
import { Tooltip, TooltipTrigger, TooltipContent } from './ui/tooltip';

type RegionFlagSize = 'sm' | 'md' | 'lg';
type RegionFlagTooltipSide = 'top' | 'right' | 'bottom' | 'left';

/**
 * RegionFlag — compact geographic identity badge.
 *
 * Tooltip is enabled by default because most surfaces only show the flag.
 * Set `showTooltip={false}` when the region name is already visible nearby.
 */
export function RegionFlag({
  region,
  size = 'sm',
  className,
  showTooltip = true,
  tooltipSide = 'bottom',
}: {
  region?: string;
  size?: RegionFlagSize;
  className?: string;
  showTooltip?: boolean;
  tooltipSide?: RegionFlagTooltipSide;
}) {
  if (!region) return null;
  const emoji = extractRegionEmoji(region);
  const text = extractRegionText(region);
  const displayName = getRegionDisplayName(region);
  const code = regionEmojiToCode(emoji);

  const ariaLabel = displayName || text || region;
  const tooltipLabel = showTooltip ? displayName : '';

  const dim = size === 'lg' ? 'h-6 min-w-6' : size === 'md' ? 'h-5 min-w-5' : 'h-4 min-w-4';
  const fallbackText = size === 'lg' ? 'text-xs' : 'text-xxs';
  const flagSize = size === 'lg' ? 18 : size === 'md' ? 15 : 12;

  // 有国家代码时渲染包内 SVG 国旗；emoji 字形在 Windows 上会退化成「JP」字母对，
  // 所以这里永远不直接渲染 emoji。没有代码（旧数据里只有文字）才回落到文字胶囊。
  const chip = code ? (
    <span
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center justify-center shrink-0',
        'cursor-default select-none',
        className,
      )}
    >
      <FlagBadge region={region} size={flagSize} />
    </span>
  ) : (
    <span
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center justify-center shrink-0 rounded-full',
        'bg-muted/40 ring-1 ring-border/40',
        'cursor-default select-none',
        dim,
        `px-1.5 ${fallbackText} font-mono text-muted-foreground/80 uppercase tracking-wider`,
        className,
      )}
    >
      <span aria-hidden>{text.slice(0, 2)}</span>
    </span>
  );

  if (!tooltipLabel) return chip;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side={tooltipSide} className="text-xs font-mono">
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  );
}
