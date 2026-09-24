// A tiny static file server for the example site and the screenshot pipeline.
//
//   node tooling/serve.mjs examples/plain-html 4173
//
// Deliberately minimal: GET only, no directory listings, no path traversal, and the CORS header a
// real host must send for /.well-known/developer-footprint.json so other sites' badges can read it.
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".sig": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function startStaticServer(rootDirectory, port = 0, host = "127.0.0.1") {
  const root = resolve(rootDirectory);
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end("method not allowed");
        return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      } catch {
        response.writeHead(400).end("bad request");
        return;
      }
      let file = normalize(join(root, pathname));
      if (file !== root && !file.startsWith(root + sep)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
      if (!existsSync(file) || !statSync(file).isFile()) {
        response.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      const headers = { "content-type": MIME[extname(file)] ?? "application/octet-stream" };
      if (pathname.startsWith("/.well-known/")) headers["access-control-allow-origin"] = "*";
      response
        .writeHead(200, headers)
        .end(request.method === "HEAD" ? undefined : await readFile(file));
    })();
  });
  return new Promise((resolveListening) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolveListening({
        server,
        port: typeof address === "object" && address !== null ? address.port : port,
      });
    });
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2] ?? ".";
  const { port } = await startStaticServer(directory, Number(process.argv[3] ?? 4173));
  console.log(`Serving ${resolve(directory)}\n  http://127.0.0.1:${port}/\nPress Ctrl+C to stop.`);
}

export const here = fileURLToPath(new URL(".", import.meta.url));
