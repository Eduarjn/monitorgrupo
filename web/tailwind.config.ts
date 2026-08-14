import type { Config } from 'tailwindcss';
// Paleta oficial ERA (brandingbook/ERA_DesignSystem.md): dark industrial,
// Fulor #CEFF00 como primária, Dark2 #1e262c como base da página.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#2C353D',                      // Dark ERA — superfícies/cards
        foreground: '#EDEDED',                      // Snow ERA — texto sobre escuro
        primary: { DEFAULT: '#CEFF00', foreground: '#2C353D' }, // Fulor
        secondary: { DEFAULT: '#1e262c', foreground: '#EDEDED' }, // Dark2 — base
        muted: { DEFAULT: 'rgba(255,255,255,0.06)', foreground: 'rgba(237,237,237,0.45)' },
        aqua: '#97B9BC',
        destructive: { DEFAULT: '#ff5050', foreground: '#EDEDED' },
        border: 'rgba(255,255,255,0.10)',
      },
      fontFamily: {
        sans: ['Barlow', 'Helvetica Neue', 'Arial', 'sans-serif'],
        display: ['Barlow Condensed', 'Barlow', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(206,255,0,0.25), 0 0 24px rgba(206,255,0,0.08)',
      },
      borderRadius: { lg: '0.5rem', xl: '0.75rem' },
    },
  },
} satisfies Config;
