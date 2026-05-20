/**
 * launcher.js - Discord Live Translator System Launcher
 * 
 * This is the main entry point. It serves the dashboard
 * and manages starting/stopping the Python transcriber and Discord Bot.
 * 
 * Usage: node launcher.js
 * Then open http://localhost:3000
 */

const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const PORT = 3000;
const BOT_PORT = 3001;
const TRANSCRIBER_PORT = 8765;

// Set NVIDIA CUDA DLL paths
const NVIDIA_PATH = path.join(
  process.env.LOCALAPPDATA || "",
  "Programs", "Python", "Python310", "lib", "site-packages", "nvidia"
);
const cudaPaths = [
  path.join(NVIDIA_PATH, "cublas", "bin"),
  path.join(NVIDIA_PATH, "cudnn", "bin"),
  path.join(NVIDIA_PATH, "cuda_nvrtc", "bin"),
].join(path.delimiter);

const app = express();
app.use(express.json());

// Serve dashboard
const dashboardPath = path.join(__dirname, "dashboard");
app.use(express.static(dashboardPath));

// Child processes
let transcriberProcess = null;
let botProcess = null;

// ── System Status ──
function getSystemStatus() {
  return {
    transcriber: transcriberProcess !== null && !transcriberProcess.killed,
    bot: botProcess !== null && !botProcess.killed,
    running: (transcriberProcess !== null && !transcriberProcess.killed) &&
             (botProcess !== null && !botProcess.killed),
  };
}

// ── Start Transcriber (Python) ──
function startTranscriber() {
  return new Promise((resolve, reject) => {
    if (transcriberProcess && !transcriberProcess.killed) {
      return resolve("already_running");
    }

    console.log("[Launcher] Starting Python Transcriber...");
    transcriberProcess = spawn("python", ["server.py"], {
      cwd: path.join(__dirname, "transcriber"),
      env: { ...process.env, PATH: cudaPaths + path.delimiter + process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });

    transcriberProcess.stdout.on("data", (d) => process.stdout.write(`[Transcriber] ${d}`));
    transcriberProcess.stderr.on("data", (d) => process.stderr.write(`[Transcriber] ${d}`));
    transcriberProcess.on("exit", (code) => {
      console.log(`[Launcher] Transcriber exited (code: ${code})`);
      transcriberProcess = null;
    });

    // Wait for server to be ready
    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      const req = http.get(`http://localhost:${TRANSCRIBER_PORT}/health`, (res) => {
        if (res.statusCode === 200) {
          clearInterval(check);
          console.log("[Launcher] Transcriber is ready!");
          resolve("started");
        }
      });
      req.on("error", () => {});
      req.end();

      if (attempts > 60) { // 60 seconds timeout
        clearInterval(check);
        resolve("started_timeout");
      }
    }, 1000);
  });
}

// ── Start Bot (Node.js) ──
function startBot() {
  return new Promise((resolve, reject) => {
    if (botProcess && !botProcess.killed) {
      return resolve("already_running");
    }

    console.log("[Launcher] Starting Discord Bot...");
    botProcess = spawn(process.execPath, ["index.js"], {
      cwd: path.join(__dirname, "bot"),
      env: { ...process.env, DASHBOARD_PORT: String(BOT_PORT) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    botProcess.stdout.on("data", (d) => process.stdout.write(`[Bot] ${d}`));
    botProcess.stderr.on("data", (d) => process.stderr.write(`[Bot] ${d}`));
    botProcess.on("exit", (code) => {
      console.log(`[Launcher] Bot exited (code: ${code})`);
      botProcess = null;
    });

    // Wait for bot to be ready
    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      const req = http.get(`http://localhost:${BOT_PORT}/api/status`, (res) => {
        if (res.statusCode === 200) {
          clearInterval(check);
          console.log("[Launcher] Bot is ready!");
          resolve("started");
        }
      });
      req.on("error", () => {});
      req.end();

      if (attempts > 30) {
        clearInterval(check);
        resolve("started_timeout");
      }
    }, 1000);
  });
}

// ── Stop All ──
function stopAll() {
  if (botProcess && !botProcess.killed) {
    botProcess.kill();
    botProcess = null;
  }
  if (transcriberProcess && !transcriberProcess.killed) {
    transcriberProcess.kill();
    transcriberProcess = null;
  }
  console.log("[Launcher] All processes stopped.");
}

// ── API Routes ──

app.get("/", (req, res) => {
  res.sendFile(path.join(dashboardPath, "index.html"));
});

app.get("/api/system-status", (req, res) => {
  res.json(getSystemStatus());
});

app.post("/api/start-system", async (req, res) => {
  try {
    const tResult = await startTranscriber();
    const bResult = await startBot();
    res.json({ ok: true, transcriber: tResult, bot: bResult });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/stop-system", (req, res) => {
  stopAll();
  res.json({ ok: true });
});

// Proxy Bot API calls (join/leave/status) to internal Bot port
function proxyToBot(req, res) {
  const options = {
    hostname: "localhost",
    port: BOT_PORT,
    path: req.originalUrl,
    method: req.method,
    headers: { "Content-Type": "application/json" },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    let body = "";
    proxyRes.on("data", (chunk) => (body += chunk));
    proxyRes.on("end", () => {
      res.status(proxyRes.statusCode).json(JSON.parse(body || "{}"));
    });
  });

  proxyReq.on("error", () => {
    res.json({ ok: false, error: "Bot is not running. Click 'Start System' first." });
  });

  if (req.body && Object.keys(req.body).length > 0) {
    proxyReq.write(JSON.stringify(req.body));
  }
  proxyReq.end();
}

app.post("/api/join", proxyToBot);
app.post("/api/leave", proxyToBot);
app.get("/api/status", proxyToBot);

// ── Cleanup on exit ──
process.on("SIGINT", () => { stopAll(); process.exit(); });
process.on("SIGTERM", () => { stopAll(); process.exit(); });
process.on("exit", () => { stopAll(); });

// ── Start Launcher ──
app.listen(PORT, () => {
  console.log("============================================");
  console.log("  Discord Live Translator - Launcher");
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log("============================================");
  console.log("");
  console.log("Open the dashboard and click 'Start' to begin.");
});
