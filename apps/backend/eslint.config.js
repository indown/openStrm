// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "src/db/migrations/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    // 测试里拿 any 造桩数据是合理的
    files: ["**/*.test.ts", "**/*.itest.ts", "**/*.e2e.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
