/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      // Semantic token layer. One role, one color — applied across the viewer
      // so "interactive/primary" and each connection state read the same on
      // every surface (toolbar, overlays, credentials modal). Hex values keep
      // Tailwind's opacity-modifier support (e.g. `bg-accent/20`).
      colors: {
        // The single "this is interactive / primary" color.
        accent: {
          DEFAULT: "#2563eb", // primary button fill (was blue-600)
          hover: "#1d4ed8", // primary button hover (was blue-700)
          soft: "#60a5fa", // icons, spinners, focus on dark (was blue-400)
        },
        // Connection-state roles — used for the status icon and overlays.
        ok: "#4ade80", // connected / success (was green-400)
        pending: "#facc15", // connecting (was yellow-400)
        retry: "#fb923c", // reconnecting (was orange-400)
        danger: "#f87171", // error (was red-400)
      },
    },
  },
  plugins: [],
};
