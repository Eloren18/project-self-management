// Local dev proxy: http://localhost:8124  →  https://<deployment>.convex.cloud
// Needed only for testing inside the in-app Browser pane, which blocks every
// non-CDN host. Forwards plain HTTP and tunnels WebSocket upgrades (Convex's
// live subscriptions run over a WebSocket). Point the app at it with
//   localStorage.setItem("psmConvexUrl", "http://localhost:8124")
//
//   node tools/convex-proxy.mjs [port] [targetHost]
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const PORT = Number(process.argv[2] || 8124);
const TARGET = process.argv[3] || process.env.CONVEX_PROXY_TARGET || "hearty-jay-608.convex.cloud";

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: TARGET };
  delete headers["accept-encoding"]; // keep bodies readable/simple
  const up = https.request({ host: TARGET, port: 443, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  up.on("error", (e) => { res.writeHead(502); res.end("proxy error: " + e.message); });
  req.pipe(up);
});

// WebSocket: replay the upgrade handshake over TLS to the target and pipe bytes both ways.
server.on("upgrade", (req, socket, head) => {
  const t = tls.connect({ host: TARGET, port: 443, servername: TARGET }, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (key === "host") lines.push(`Host: ${TARGET}`);
      else if (key === "origin") lines.push(`Origin: https://${TARGET}`);
      else lines.push(`${k}: ${v}`);
    }
    t.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) t.write(head);
    socket.pipe(t); t.pipe(socket);
  });
  const kill = () => { try { socket.destroy(); } catch {} try { t.destroy(); } catch {} };
  t.on("error", kill); socket.on("error", kill);
});

server.listen(PORT, () => console.log(`convex-proxy: http://localhost:${PORT} → https://${TARGET}`));
