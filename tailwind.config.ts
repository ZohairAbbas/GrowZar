import type { Config } from 'tailwindcss';

/**
 * Growzar's palette (theme.png): Deep Navy canvas, Surface panels, Signal Mint
 * accent, Electric Cyan for data, Leak Coral for loss, Light Field background.
 *
 * The stock names (gray, primary, accent, green, red) are remapped onto it so
 * existing classes pick the theme up. Mint and coral are too light to read as
 * text on a light ground, so their text shades (600+) are darkened.
 */
const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"DM Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['"Bricolage Grotesque"', '"DM Sans"', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Named theme colors.
        navy: {
          DEFAULT: '#06191D',
          surface: '#0B2A30',
          line: '#1A4A53',
          muted: '#9FC0BE',
        },
        field: '#F2F7F6',
        mint: {
          DEFAULT: '#2FE7C4',
          50: '#E6FBF6',
          100: '#C9F7EC',
          200: '#9DF0DE',
          600: '#0A7F6B',
          700: '#086B5A',
        },
        coral: {
          DEFAULT: '#FF8A6B',
          50: '#FFF1EC',
          100: '#FFE0D6',
          200: '#FFD3C5',
          600: '#C24A2C',
          700: '#9A3A20',
        },
        data: {
          DEFAULT: '#5AD7FF',
          100: '#D3F1FF',
          700: '#0B5E7A',
        },
        // Stock names, remapped.
        gray: {
          50: '#F2F7F6',
          100: '#E7EFEE',
          200: '#DCE7E5',
          300: '#C3D3D1',
          400: '#8AA3A2',
          500: '#4F6A6E',
          600: '#3F5C5B',
          700: '#24403F',
          800: '#133035',
          900: '#06191D',
        },
        primary: {
          50: '#E7EFEE',
          100: '#DCE7E5',
          200: '#C3D3D1',
          300: '#8AA3A2',
          400: '#1A4A53',
          500: '#06191D',
          600: '#0B2A30',
          700: '#06191D',
          800: '#041316',
          900: '#020B0D',
        },
        accent: {
          50: '#E6FBF6',
          100: '#C9F7EC',
          200: '#9DF0DE',
          300: '#63EBD1',
          400: '#2FE7C4',
          500: '#0A7F6B',
          600: '#086B5A',
          700: '#065548',
          800: '#054238',
          900: '#06312B',
        },
        green: {
          50: '#E6FBF6',
          100: '#C9F7EC',
          200: '#9DF0DE',
          500: '#2FE7C4',
          600: '#0A7F6B',
          700: '#086B5A',
          800: '#065548',
        },
        red: {
          50: '#FFF1EC',
          100: '#FFE0D6',
          200: '#FFC9B8',
          500: '#FF8A6B',
          600: '#C24A2C',
          700: '#9A3A20',
          800: '#7A2C17',
        },
        // No yellow in the palette: warnings sit in the coral family.
        amber: {
          50: '#FFF4EE',
          100: '#FFE6DA',
          200: '#FFD3C5',
          500: '#FF8A6B',
          600: '#C24A2C',
          700: '#9A3A20',
          800: '#7A2C17',
          900: '#5E2412',
        },
        success: {
          50: '#E6FBF6',
          100: '#C9F7EC',
          500: '#2FE7C4',
          600: '#0A7F6B',
        },
        warning: {
          50: '#fffbeb',
          100: '#fef3c7',
          500: '#f59e0b',
          600: '#d97706',
        },
      },
      boxShadow: {
        'xs': '0 1px 2px 0 rgba(6, 25, 29, 0.05)',
        'sm': '0 1px 2px 0 rgba(6, 25, 29, 0.06)',
        DEFAULT: '0 1px 3px 0 rgba(6, 25, 29, 0.08), 0 1px 2px 0 rgba(6, 25, 29, 0.05)',
        'md': '0 4px 12px -2px rgba(6, 25, 29, 0.08)',
        'lg': '0 12px 24px -6px rgba(6, 25, 29, 0.12)',
        'xl': '0 20px 40px -8px rgba(6, 25, 29, 0.18)',
      },
      borderRadius: {
        'sm': '0.375rem',
        DEFAULT: '0.5rem',
        'md': '0.625rem',
        'lg': '0.75rem',
        'xl': '0.875rem',
        '2xl': '1.375rem',
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-in-out',
        'slide-down': 'slideDown 0.2s ease-out',
        'shimmer': 'shimmer 2s infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-1000px 0' },
          '100%': { backgroundPosition: '1000px 0' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
