import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "import", "unicorn", "node"],
  env: { builtin: true, es2018: true, node: true },
  ignorePatterns: ["dist/**", "node_modules/**", "src/generated/**"],
  rules: {
    "typescript/no-floating-promises": "off",
    "import/no-named-as-default": "warn",
    "import/no-named-as-default-member": "warn",
    "import/no-duplicates": "warn",
    "no-var": "error",
    "prefer-rest-params": "error",
    "prefer-spread": "error",
    "typescript/ban-ts-comment": "off",
    "typescript/no-empty-object-type": "off",
    "typescript/await-thenable": "off",
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "typescript/consistent-type-imports": "off",
    "typescript/explicit-function-return-type": "off",
    "typescript/array-type": "off",
    "no-empty": "warn",
    eqeqeq: ["error", "always"],
    "typescript/no-explicit-any": "error",
    "unicorn/prefer-node-protocol": "error",
  },
});
