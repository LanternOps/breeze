/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './taskpane.html',
    './src/**/*.{ts,tsx}',
    '../../packages/office-addin-core/src/**/*.{ts,tsx}',
  ],
  theme: { extend: {} },
  plugins: [],
};
