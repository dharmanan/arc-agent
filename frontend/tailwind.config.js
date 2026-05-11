/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Manrope', 'system-ui', 'sans-serif'],
      },
      colors: {
        arc: {
          green: '#2F6E0C',
          greenLight: '#66D121',
          greenBg: '#eef7e8',
          greenHover: '#25580A',
        },
      },
      boxShadow: {
        card: '0 18px 40px rgba(15,23,42,0.06)',
      },
      backgroundImage: {
        'arc-gradient':
          'radial-gradient(circle at top left, rgba(102,209,33,0.14), transparent 28%), radial-gradient(circle at top right, rgba(47,110,12,0.08), transparent 24%), linear-gradient(180deg, #f8faf7 0%, #f1f5ef 100%)',
      },
    },
  },
  plugins: [],
};
