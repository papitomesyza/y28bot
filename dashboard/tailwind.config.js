/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        green: '#00D341',
        red: '#FF3B3B',
        bg: '#0C0C0C',
        card: '#0A0A0A',
        border: '#1A1A1A',
        textPrimary: '#FFFFFF',
        textSecondary: '#888888',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
