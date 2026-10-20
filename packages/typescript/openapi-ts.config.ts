import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./spec/agent-openapi.yaml",
  output: {
    path: process.env.SANDBOX_SDK_GENERATED_OUT ?? "./src/generated",
    clean: true,
    importFileExtension: ".js",
    tsConfigPath: "./tsconfig.json",
    postProcess: [],
  },
  plugins: [
    { name: "@hey-api/typescript", exportFromIndex: true },
    { name: "@hey-api/sdk", exportFromIndex: true, auth: false, paramsStructure: "flat" },
    { name: "@hey-api/client-fetch", exportFromIndex: true, throwOnError: false },
  ],
});
