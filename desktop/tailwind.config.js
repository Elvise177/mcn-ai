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
        // 覆盖 Tailwind 默认的 leading-snug(1.375)：刻度表定 1.45（按钮/列表单行）
        snug: 'var(--leading-snug)',
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
        /**
         * 8 点栅格 7 档（DESIGN-scale §1）。这里先用 extend 把 1/2/3/4/6/8/12 **指到 token**，
         * 值与 Tailwind 默认逐像素相同 → 现阶段零视觉变化，但 `--space-*` 已成唯一真相源。
         * 半步类（p-1.5 / px-2.5 / p-5 / p-10）此刻仍是 Tailwind 默认值。
         * **批 4 的切换动作**：把这一段从 extend 挪到 theme.spacing 整体覆盖
         * （{0, px, 1,2,3,4,6,8,12} + 下面的具名尺寸），同时跑脚本把 560 处半步类替换掉，
         * 并给走查加 spacing 白名单断言——覆盖后 p-5 这类类名 Tailwind 会静默不生成，typecheck 不报。
         */
        1: 'var(--space-1)',
        2: 'var(--space-2)',
        3: 'var(--space-3)',
        4: 'var(--space-4)',
        6: 'var(--space-6)',
        8: 'var(--space-8)',
        12: 'var(--space-12)',
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
        // 模态/右键菜单（DESIGN-scale §4 第 3 档）
        modal: 'var(--shadow-modal)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
      },
    },
    /**
     * 字重语义映射（DESIGN-scale §5）：**整体覆盖**，不是 extend——把 `font-bold`(700) 排除出可用集。
     * 中文系统黑体 700 与 600 差异小且发糊，需要更重就用字号。现有代码 0 处 font-bold（实测），
     * 覆盖不影响任何存量；新代码只能在 normal / medium / semibold 三档里选。
     */
    fontWeight: {
      normal: '400',
      medium: '500',
      semibold: '600',
    },
  },
  plugins: [],
}
