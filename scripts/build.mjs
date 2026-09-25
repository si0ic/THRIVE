import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const file of ["index.html", "styles.css", "app.js", "admin.html", "admin.js", "thrive-window.jpg", "india-heat-map.jpg"]) {
  await cp(path.join(root, file), path.join(output, file));
}

console.log("Built THRIVE static frontend in dist/");
