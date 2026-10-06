// A color per language, as standard SRT <font color> tags. Players that keep
// inline styles show it (mpv / libmpv, NuvioTV's ExoPlayer); Nuvio's phone
// ExoPlayer drops all inline styling, so there the lines stay one color.

export interface LineColors {
    /** "#RRGGBB" for the main (film) language line. */
    main?: string;
    /** "#RRGGBB" for the translation line. */
    trans?: string;
}

const FONT_TAG = /<\/?font\b[^>]*>/gi;

/**
 * Colors the whole block (a color spanning two lines is fine for Media3's
 * SRT parser and for mpv's; wrapping lines one by one would mis-nest a
 * source <i> that spans them). Colors already in the source are dropped.
 */
export function paint(text: string, color?: string): string {
    if (!color || !text.trim()) return text;
    return `<font color="${color}">${text.replace(FONT_TAG, '')}</font>`;
}

/** How a merged entry is written: main line bold, translation in italics after "> ". */
export function dualFormatter(colors: LineColors = {}): (main: string | null, trans: string | null) => string {
    return (main, trans) => {
        if (main !== null && trans !== null) {
            return `${paint(`<b>${main}</b>`, colors.main)}\n${paint(`<i>> ${trans}</i>`, colors.trans)}`.trim();
        }
        if (main !== null) return paint(main, colors.main);
        return paint(`<i>> ${trans ?? ''}</i>`, colors.trans);
    };
}

export const COLOR_OPTIONS = [
    'Yellow [#FFE066]', 'Light blue [#8CD9FF]', 'White [#FFFFFF]', 'Light green [#A8F0A0]',
    'Pink [#FFB3D9]', 'Orange [#FFB066]', 'Player default (no color) [none]'
] as const;
export const DEFAULT_MAIN_COLOR = 'Yellow [#FFE066]';
export const DEFAULT_TRANS_COLOR = 'Light blue [#8CD9FF]';

/**
 * A color setting from the add-on link: "Yellow [#FFE066]", "#FFE066" or
 * "... [none]". Missing → the default (links installed before colors existed
 * get them too); anything that isn't a plain #RRGGBB → no color, so nothing
 * but a color ever reaches the subtitle text.
 */
export function parseColor(value: unknown, fallback: string): string | undefined {
    const raw = value === undefined || value === null || value === '' ? fallback : String(value);
    const inside = /\[([^\]]*)\]\s*$/.exec(raw);
    const code = (inside ? inside[1] : raw).trim();
    return /^#[0-9a-f]{6}$/i.test(code) ? code.toUpperCase() : undefined;
}
