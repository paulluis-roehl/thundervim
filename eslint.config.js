import js from "@eslint/js";
import tseslint from "typescript-eslint";

const browserGlobals = {
  browser: "readonly",
  console: "readonly",
  document: "readonly",
  globalThis: "readonly",
  navigator: "readonly",
  window: "readonly",
};

const nodeGlobals = {
  console: "readonly",
  process: "readonly",
};

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: browserGlobals,
    },
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      globals: nodeGlobals,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  {
    files: ["scripts/**/*.js", "eslint.config.js"],
    languageOptions: {
      globals: nodeGlobals,
    },
    rules: {
      "no-undef": "error",
    },
  },
);
