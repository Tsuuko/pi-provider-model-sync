import type { OxlintConfig } from "oxlint";

const config: OxlintConfig = {
  plugins: ["typescript"],
  rules: {
    "typescript/no-explicit-any": "error",
    "typescript/no-unused-vars": "error"
  }
};

export default config;
