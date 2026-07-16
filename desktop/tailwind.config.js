/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        sidebar: 'var(--sidebar)',
        line: 'var(--border)',
        card: 'var(--card)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        rose: 'var(--rose)',
        'rose-soft': 'var(--rose-soft)',
      },
    },
  },
  plugins: [],
}
