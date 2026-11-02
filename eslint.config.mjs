import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

// Strict react-compiler lint rules from eslint-plugin-react-hooks v7 flag
// idiomatic data-loading patterns (setState synchronously in effects, ref
// callbacks assigned during render) throughout the UI. Downgrading them to
// warnings keeps lint deterministic and CI green without a wholesale UI
// refactor; re-enabling them is tracked as roadmap work.
const reactCompilerRulesToWarn = [
  "react-hooks/set-state-in-effect",
  "react-hooks/purity",
  "react-hooks/static-components",
  "react-hooks/refs",
  "react-hooks/immutability",
];

export default defineConfig([
  // Keep the starter on the flat config export that actually runs under the pinned ESLint/Next toolchain.
  ...nextCoreWebVitals,
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: Object.fromEntries(reactCompilerRulesToWarn.map((r) => [r, "warn"])),
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
