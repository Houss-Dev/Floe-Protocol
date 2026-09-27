/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        paper: "#ffffff",
        surface: "#ffffff",
        surface2: "#f6f6f8",
        surface3: "#ececef",
        line: "rgba(11,11,15,0.08)",
        line2: "rgba(11,11,15,0.12)",
        foreground: "#0b0b0f",
        muted: "rgba(11,11,15,0.58)",
        faint: "rgba(11,11,15,0.38)",
        accent: "#1a9e5c",
        accent2: "#7b3fe4",
        brand: "#9b59f5",
        tint: {
          purple: "#f3f0ff",
          green: "#ecfdf5",
          blue: "#eef6ff",
          amber: "#fff8eb",
          slate: "#f6f6f8",
        },
        danger: "#e03500",
        warn: "#d97706",
        info: "#0284c7",
        hot: "#ff4d1c",
        pro: {
          bg: "#0a0a0c",
          panel: "#111113",
          elevated: "#18181b",
          hover: "#222226",
          border: "rgba(244,240,229,0.08)",
          text: "#f4f0e5",
          muted: "rgba(244,240,229,0.55)",
          faint: "rgba(244,240,229,0.35)",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
        condensed: ["Anton", "Inter", "sans-serif"],
      },
    },
  },
  plugins: [],
};
