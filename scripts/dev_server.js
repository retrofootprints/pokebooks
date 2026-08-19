#!/usr/bin/env node
// Minimal static file server with HTTP Range request support, for local
// testing only (sql.js-httpvfs requires Range support; GitHub Pages
// provides it in production, but Node's usual one-liners don't).
// Usage: node scripts/dev_server.js [port]
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2]) || 8080;

const MIME = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm",
  ".sqlite3": "application/octet-stream", ".jpg": "image/jpeg", ".png": "image/png",
  ".gz": "application/gzip",
};

http
  .createServer((req, res) => {
    let filePath = decodeURIComponent(req.url.split("?")[0]);
    if (filePath === "/") filePath = "/index.html";
    // db chunk files have no extension recognized above but are numeric suffixes
    const full = path.join(ROOT, filePath);
    if (!full.startsWith(ROOT)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.stat(full, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404);
        res.end("not found: " + filePath);
        return;
      }
      const ext = path.extname(full);
      const mime = MIME[ext] || "application/octet-stream";
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
        end = Math.min(end, stat.size - 1);
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          "Content-Type": mime,
        });
        fs.createReadStream(full, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": stat.size,
          "Content-Type": mime,
          "Accept-Ranges": "bytes",
        });
        fs.createReadStream(full).pipe(res);
      }
    });
  })
  .listen(PORT, () => console.log(`dev server on http://localhost:${PORT}`));
