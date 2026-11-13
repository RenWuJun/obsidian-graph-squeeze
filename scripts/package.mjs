import { mkdir, copyFile } from "node:fs/promises";

const directory = "dist/graph-squeeze";
await mkdir(directory, { recursive: true });
await mkdir(`${directory}/assets`, { recursive: true });
for (const file of ["main.js", "manifest.json", "README.md", "LICENSE"]) {
  await copyFile(file, `${directory}/${file}`);
}
await copyFile("assets/graph-squeeze.png", `${directory}/assets/graph-squeeze.png`);
console.log(`Installable plugin: ${directory}`);
