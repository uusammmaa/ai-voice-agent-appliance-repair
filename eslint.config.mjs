import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Flat config. Next 16 ships eslint-config-next as flat config and drops `next lint`,
 * so lint runs through eslint directly.
 */
const config = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [".next/**", "node_modules/**", "playwright-report/**", "test-results/**", "coverage/**"],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
  {
    // Report scripts and tests legitimately print and legitimately use loose types.
    files: ["src/evals/report.ts", "tests/**/*.ts"],
    rules: { "no-console": "off" },
  },
];

export default config;
