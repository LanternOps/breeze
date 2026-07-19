/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        'ws-canvas': 'var(--ws-canvas)',
        'ws-surface': 'var(--ws-surface)',
        'ws-raised': 'var(--ws-raised)',
        'ws-ink': 'var(--ws-ink)',
        'ws-secondary': 'var(--ws-text-secondary)',
        'ws-tertiary': 'var(--ws-text-tertiary)',
        'ws-accent': 'var(--ws-accent)',
        'ws-accent-soft': 'var(--ws-accent-soft)',
        'ws-border': 'var(--ws-border)',
        'ws-border-subtle': 'var(--ws-border-subtle)',
      },
      fontFamily: { sans: ['Inter Variable', '-apple-system', 'Segoe UI', 'system-ui', 'sans-serif'] },
      borderRadius: { control: 'var(--ws-radius-control)', surface: 'var(--ws-radius-surface)' },
    },
  },
  plugins: [],
};
