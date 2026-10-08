/**
 * Tag parsing — converts the Komari tag string into structured pills.
 *
 * Tag string is operator-authored in the Komari admin UI. We accept either
 * `,` or `;` as the separator (lenient — historical), and we honor an
 * optional `<color>` suffix on each tag so the same data renders with
 * consistent semantic color across any Komari theme:
 *
 *   "production<red>;edge<blue>;backup<gray>"
 *
 * Color names are first looked up in our curated palette (8 colors). Names
 * from the broader Radix 25-color convention used by other themes are
 * collapsed into the nearest palette entry via {@link COLOR_ALIASES} so a
 * tag authored as `prod<ruby>` still gets a red pill here. Unknown color
 * names are treated as part of the label (the `<xxx>` text stays visible),
 * matching the "fall back to plain text" behavior of the reference theme.
 */

export const TAG_COLORS = [
  'red',
  'amber',
  'green',
  'cyan',
  'blue',
  'violet',
  'pink',
  'gray',
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

/**
 * Maps every color name used by the cross-theme Radix-25 convention onto
 * one of our 8 curated palette entries. Anything not listed here is treated
 * as plain text (the `<xxx>` suffix is kept verbatim in the label).
 */
const COLOR_ALIASES: Readonly<Record<string, TagColor>> = {
  ruby: 'red',
  crimson: 'red',
  tomato: 'red',
  red: 'red',

  gold: 'amber',
  bronze: 'amber',
  brown: 'amber',
  yellow: 'amber',
  amber: 'amber',
  orange: 'amber',

  jade: 'green',
  green: 'green',
  grass: 'green',
  lime: 'green',
  mint: 'green',

  cyan: 'cyan',
  teal: 'cyan',
  sky: 'cyan',

  blue: 'blue',
  indigo: 'blue',

  iris: 'violet',
  violet: 'violet',
  purple: 'violet',
  plum: 'violet',

  pink: 'pink',

  gray: 'gray',
};

const SUFFIX_RE = /<([a-z]+)>$/i;

export interface ParsedTag {
  label: string;
  color: TagColor | null;
}

export function parseTag(raw: string): ParsedTag | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = SUFFIX_RE.exec(trimmed);
  if (match) {
    const resolved = COLOR_ALIASES[match[1].toLowerCase()];
    if (resolved) {
      const label = trimmed.slice(0, match.index).trim();
      if (label) return { label, color: resolved };
    }
  }
  return { label: trimmed, color: null };
}

export function parseTagList(tags: string | null | undefined): ParsedTag[] {
  if (!tags) return [];
  const parts = tags.split(/[,;]/);
  const out: ParsedTag[] = [];
  for (let i = 0; i < parts.length; i++) {
    const parsed = parseTag(parts[i]);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function parseTagLabels(tags: string | null | undefined): string[] {
  return parseTagList(tags).map(p => p.label);
}

/**
 * 公开备注 → 标签清单。站长在极简探针后台把备注写成逗号清单，
 * 每一项渲染成一枚标签；半角/全角逗号、分号、顿号都认，空项与重复项丢掉。
 */
export function splitRemarkTags(remark: string | null | undefined): string[] {
  if (!remark) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of remark.split(/[,;，；、]/)) {
    const label = part.trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

export interface TagChip {
  label: string;
  color: TagColor | null;
  /** true = 来自公开备注（Monitor 没有 Komari 标签字段，备注就是站长的标签清单） */
  isRemark: boolean;
}

/**
 * 标签行的统一口径：Komari tags（Monitor 上恒为空）+ 公开备注拆出的标签。
 * 所有出现标签的界面（卡片 / 表格 / 地球侧栏 / 详情页）都从这里取数，
 * 保证同一台机器在哪里展示的标签都一致。
 */
export function buildTagChips(
  tags: string | null | undefined,
  publicRemark: string | null | undefined,
): TagChip[] {
  const parsed = parseTagList(tags).sort((a, b) => (a.color ? 0 : 1) - (b.color ? 0 : 1));
  const remarks = splitRemarkTags(publicRemark).map(label => ({ label, color: null, isRemark: true }));
  return [...parsed.map(t => ({ ...t, isRemark: false })), ...remarks];
}
