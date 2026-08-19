/** @type {import('tailwindcss').Config} */
// 这里只做「语义类名 → design token」的映射，具体数值全部在
// src/renderer/src/styles/theme.css（唯一真相源），组件里不允许再出现硬编码色值。
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--color-bg)',
        sidebar: 'var(--color-sidebar)',
        card: 'var(--color-card)',
        surface: 'var(--color-surface)',
        line: 'var(--color-border)',
        ink: 'var(--color-ink)',
        'ink-soft': 'var(--color-ink-soft)',
        muted: 'var(--color-muted)',
        'muted-soft': 'var(--color-muted-soft)',
        hover: 'var(--color-hover)',
        'hover-strong': 'var(--color-hover-strong)',
        overlay: 'var(--color-overlay)',
        // 「面」用 --color-accent（品牌橙足量），Tailwind 的 text-* 走 --color-accent-ink（压深到 AA）。
        // textColor 里的 accent 覆盖了这里的同名值，见下面的 textColor 段
        accent: 'var(--color-accent)',
        'accent-soft': 'var(--color-accent-soft)',
        'accent-line': 'var(--color-accent-line)',
        'on-solid': 'var(--color-on-solid)',
        danger: 'var(--color-danger)',
        'danger-soft': 'var(--color-danger-soft)',
        ok: 'var(--color-ok)',
        warning: 'var(--color-warning)',
        'warning-soft': 'var(--color-warning-soft)',
        warn: 'var(--color-warn)',
        'warn-soft': 'var(--color-warn-soft)',
        'warn-line': 'var(--color-warn-line)',
        'gold-ink': 'var(--color-gold-ink)',
        'gold-soft': 'var(--color-gold-soft)',
        'gold-line': 'var(--color-gold-line)',
        'tier-standard': 'var(--color-tier-standard)',
        'tier-enhanced': 'var(--color-tier-enhanced)',
        'file-ppt': 'var(--color-file-ppt)',
        'file-doc': 'var(--color-file-doc)',
        'file-xls': 'var(--color-file-xls)',
        'file-pdf': 'var(--color-file-pdf)',
        'file-md': 'var(--color-file-md)',
        'file-other': 'var(--color-file-other)',
        'table-head': 'var(--color-table-head)',
        'divider-hover': 'var(--color-divider-hover)',
      },
      textColor: {
        // text-accent 单独指向 accent-ink：#E8590C 当正文只有 3.4:1，压深到 #C2500C 才够 AA。
        // 深色侧栏里两者都被改写成提亮橙（见 theme.css 的 .sidebar-dark），行为一致
        accent: 'var(--color-accent-ink)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        serif: 'var(--font-serif)',
        brand: 'var(--font-brand)',
        mono: 'var(--font-mono)',
      },
      fontSize: {
        '2xs': 'var(--text-2xs)',
        xs: 'var(--text-xs)',
        sm: 'var(--text-sm)',
        base: 'var(--text-base)',
        md: 'var(--text-md)',
        lg: 'var(--text-lg)',
        xl: 'var(--text-xl)',
        '2xl': 'var(--text-2xl)',
        '3xl': 'var(--text-3xl)',
        display: 'var(--text-display)',
      },
      lineHeight: {
        base: 'var(--leading-base)',
        tight: 'var(--leading-tight)',
      },
      borderRadius: {
        DEFAULT: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        input: 'var(--radius-input)',
        full: 'var(--radius-full)',
      },
      spacing: {
        sidebar: 'var(--size-sidebar)',
        'artifact-panel': 'var(--size-artifact-panel)',
        tree: 'var(--size-tree)',
        input: 'var(--size-input)',
        modal: 'var(--size-modal)',
        toast: 'var(--size-toast)',  // max-w-toast：宽度上限，不是固定宽
        'modal-wide': 'var(--size-modal-wide)',
        'graph-panel': 'var(--size-graph-panel)',
        'home-top': 'var(--home-top)',
        divider: 'var(--size-divider)',
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
      },
    },
  },
  plugins: [],
}
