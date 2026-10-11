import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";

/** robots.txt et sitemap.xml, à partir de l'adresse publique du site (`VITE_SITE_URL`). */
function seoFiles(siteUrl: string): Plugin {
  return {
    name: "seo-files",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "robots.txt", source: `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n` });
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}/</loc></url>\n</urlset>\n`,
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)));
  return {
    plugins: [seoFiles(env.VITE_SITE_URL)],
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
        output: {
          // three.js et Spark à part : un déploiement du site ne fait pas retélécharger les 3 Mo du moteur
          advancedChunks: {
            groups: [{ name: "engine", test: /node_modules[\\/](three|three-mesh-bvh|@sparkjsdev)[\\/]/ }],
          },
        },
      },
    },
  };
});
