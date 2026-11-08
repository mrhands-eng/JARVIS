const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "src", "renderer");
const dest = path.join(root, "dist", "renderer");
fs.mkdirSync(dest, { recursive: true });
for (const file of ["index.html", "styles.css", "app.js"]) {
  fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
console.log("Copied renderer static assets.");
