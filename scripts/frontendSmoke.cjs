const { spawn } = require("node:child_process");

const url = process.env.FRONTEND_SMOKE_URL || "http://localhost:5173";
const chromeCandidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);

const runChrome = (chromePath) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      chromePath,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--virtual-time-budget=5000",
        "--dump-dom",
        url
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(stderr || `Chrome exited with ${code}`));
        return;
      }
      resolve(stdout);
    });
  });

const main = async () => {
  let lastError = null;

  for (const chromePath of chromeCandidates) {
    try {
      const html = await runChrome(chromePath);
      const visibleShell =
        html.includes("Jarvis Dashboard") && html.includes("Passcode");
      const visibleFallback =
        html.includes("Startup Error") && html.includes("Reload");
      const hasNonEmptyApp = /<div id="app">[\s\S]+<\/div>/.test(html);

      if (hasNonEmptyApp && (visibleShell || visibleFallback)) {
        console.log(`Frontend smoke passed for ${url}`);
        return;
      }

      throw new Error("Jarvis login shell or startup fallback was not visible.");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("No Chrome executable found.");
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
