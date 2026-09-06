import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    restoreMocks: true,
    // Whole-App jsdom tests run ~4s each; 5s leaves no margin under parallel load.
    testTimeout: 20000,
  },
});
