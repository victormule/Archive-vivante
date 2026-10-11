import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Spark embarque ses workers/wasm : on évite le pré-bundling de Vite
  optimizeDeps: { exclude: ["@sparkjsdev/spark"] },
  server: { port: 5173, open: true },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4000,
    // Deux pages : le site (scène 3D) et le formulaire de contribution, léger, sans three.js
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        participer: fileURLToPath(new URL("./participer/index.html", import.meta.url)),
      },
    },
  },
});
