/**
 * Real-window GUI smoke test, PiX-style: build output must already exist
 * (`npm run build`), then this script serves the renderer through the demo
 * vite server, boots the actual Electron app against it with the preload
 * skipped (AWEFORK_DEMO=1), and asserts the rendered DOM over CDP — no
 * jsdom stand-in, the same pixels and events a user gets.
 *
 * The mock adapter (demo/mock-adapter.ts) is the backend here, so every
 * assertion rides the hand-written fork story instead of a live opencode.
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const electron = createRequire(import.meta.url)("electron");

// ── demo vite server: DEV-mode renderer, random port ──────────────────
const { createServer } = await import("vite");
const { default: vue } = await import("@vitejs/plugin-vue");
const demoServer = await createServer({
  configFile: false,
  root: join(root, "src/renderer"),
  plugins: [vue()],
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
await demoServer.listen();
const demoUrl = demoServer.resolvedUrls.local[0];

// ── Electron under test: isolated HOME, random CDP port ───────────────
const testHome = await mkdtemp(join(tmpdir(), "awefork-gui-home-"));
const cdpPort = 9800 + Math.floor(Math.random() * 500);
const child = spawn(electron, ["--no-sandbox", "--disable-gpu", `--remote-debugging-port=${cdpPort}`, root], {
  cwd: root,
  env: {
    ...process.env,
    HOME: testHome,
    AWEFORK_DEMO: "1",
    AWEFORK_DEMO_URL: demoUrl,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += String(chunk)));

let demoClosed = false;
async function cleanup(code) {
  if (demoClosed) return;
  demoClosed = true;
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  child.kill("SIGKILL");
  // vite's close() waits on renderer sockets and can outlive the app; the
  // watchdog below is the real deadline, exit() is the honest one.
  await Promise.race([demoServer.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  process.exit(code);
}
// Never let a wedged CDP connection hang a pipeline: hard deadline.
setTimeout(() => {
  console.error("gui smoke: global 240s watchdog fired");
  void cleanup(1);
}, 240_000).unref();
process.on("SIGINT", () => void cleanup(130));
process.on("SIGTERM", () => void cleanup(143));

// ── CDP over a raw WebSocket: evaluate, assert, retry until ready ─────
class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
  }
  open() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    }).then(() => {
      // Attached only once the socket is live: responses and CDP events both
      // land here, matched back to the awaiting send() by id.
      this.socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        message.error
          ? pending.reject(new Error(message.error.message))
          : pending.resolve(message.result);
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result?.value;
  }
}

async function retry(fn, timeout = 20_000, label) {
  const start = Date.now();
  let error;
  while (Date.now() - start < timeout) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited early (${child.exitCode})\n${stderr}`);
    }
    try {
      return await fn();
    } catch (cause) {
      error = cause;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Timed out after ${timeout}ms: ${label}\n${error ?? ""}\n${stderr}`);
}

/** Set a form control's value the Vue v-model way: prototype setter + input event. */
const fillTextarea = (selector, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  set.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

let cdp;
try {
  const target = await retry(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    const page = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!page) throw new Error("Electron page target missing");
    return page;
  }, 30_000, "CDP page target");
  cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Runtime.enable");

  // 1. Boot: mock adapter answers, canvas and sidebar actually rendered.
  await retry(async () => {
    const boot = await cdp.evaluate(`({
      turns: document.querySelectorAll(".turn").length,
      sidebar: Boolean(document.querySelector(".sidebar")),
      projects: document.querySelectorAll(".proj-row").length,
    })`);
    if (boot.turns < 2 || !boot.sidebar || boot.projects < 1) {
      throw new Error(`boot state incomplete: ${JSON.stringify(boot)}`);
    }
  }, 30_000, "renderer boot");
  check("boot renders canvas with demo fork story", true);

  // 2. Clicking a turn selects it.
  await cdp.evaluate(`document.querySelectorAll(".turn")[0].click()`);
  const selected = await retry(
    () => cdp.evaluate(`Boolean(document.querySelector(".turn.selected"))`),
    5000,
    "turn selection",
  );
  check("turn click selects the node", selected === true);

  // 3. Prompt flow: send a message, watch it stream, land in the transcript.
  const prompt = `gui-smoke-${Date.now()}`;
  await retry(() => cdp.evaluate(fillTextarea(".chat-input textarea", prompt)), 5000, "composer fill");
  await cdp.evaluate(`document.querySelector(".chat-input .send").click()`);
  await retry(() => cdp.evaluate(`Boolean(document.querySelector(".chat-input .abort"))`), 10_000, "running state");
  check("sent prompt flips composer into running state", true);
  await retry(async () => {
    const done = await cdp.evaluate(`({
      idle: Boolean(document.querySelector(".chat-input .send")),
      reply: document.querySelector(".message-list")?.textContent.includes("演示模式") ?? false,
      echo: document.querySelector(".message-list")?.textContent.includes(${JSON.stringify(prompt)}) ?? false,
      thought: Boolean(document.querySelector(".message-list details.thought")),
    })`);
    if (!done.idle || !done.reply || !done.echo || !done.thought) {
      throw new Error(`run not settled: ${JSON.stringify(done)}`);
    }
  }, 30_000, "streamed reply");
  check("mock run streams thinking + text into the transcript", true);

  // 4. Fork flow: ＋ on a mid turn opens a draft; sending grows a new branch.
  await retry(() => cdp.evaluate(`document.querySelectorAll(".turn .add-chip")[0].click()`), 5000, "open draft");
  const draft = await retry(
    () => cdp.evaluate(`Boolean(document.querySelector(".draft textarea"))`),
    5000,
    "draft visible",
  );
  check("＋ chip opens the draft box", draft === true);
  await retry(() => cdp.evaluate(fillTextarea(".draft textarea", "gui-smoke 分支第一回合")), 5000, "draft fill");
  await cdp.evaluate(`document.querySelector(".draft .send-btn").click()`);
  await retry(async () => {
    // The forked session inherits the cut prefix, so its canvas node is a
    // turn (not a stub) under the demo-fork id the mock adapter hands out.
    const forked = await cdp.evaluate(`({
      node: Boolean(document.querySelector('.turn[data-node-id^="demo-fork-"]')),
      draftGone: !document.querySelector(".draft"),
    })`);
    if (!forked.node || !forked.draftGone) {
      throw new Error(`fork not grown: ${JSON.stringify(forked)}`);
    }
  }, 15_000, "fork grown");
  check("draft send forks a new branch onto the canvas", true);

  // 5. No error toast survived the whole run.
  const errorToast = await cdp.evaluate(`document.querySelector(".toast.banner-error")?.textContent ?? ""`);
  check("no error toast raised", errorToast === "", errorToast);

  // 6. Sidebar panel layout: drag-resize clamps to min/max, the width
  //    survives a reload, and double-click collapse hands the freed pixels
  //    to the canvas then gives them back on the next double-click. This
  //    runs on a live desktop, so every drag re-targets from the measured
  //    width: a stray real mousemove riding the window-level drag listener
  //    costs a retry, not the run. Targets beyond the limits (100/500)
  //    exercise the clamps rather than landing on them by accident.
  const panelWidth = (selector) =>
    cdp.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error(${JSON.stringify(`${selector} missing from the DOM`)});
      return el.getBoundingClientRect().width;
    })()`);
  const sidebarHandleCenter = () =>
    cdp.evaluate(`(() => {
      const r = document.querySelectorAll(".shell .col-handle")[0].getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
  const mouse = (type, params) => cdp.send("Input.dispatchMouseEvent", { type, ...params });
  async function dragSidebarHandle(dx) {
    const p = await sidebarHandleCenter();
    await mouse("mouseMoved", p);
    await mouse("mousePressed", { button: "left", buttons: 1, clickCount: 1, ...p });
    await mouse("mouseMoved", { buttons: 1, x: p.x + dx, y: p.y });
    await mouse("mouseReleased", { button: "left", buttons: 0, clickCount: 1, x: p.x + dx, y: p.y });
  }
  async function dblclickSidebarHandle() {
    const p = await sidebarHandleCenter();
    await mouse("mouseMoved", p);
    for (const count of [1, 2]) {
      await mouse("mousePressed", { button: "left", clickCount: count, ...p });
      await mouse("mouseReleased", { button: "left", clickCount: count, ...p });
      if (count === 1) await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  const near = (value, expected, tolerance = 2) => Math.abs(value - expected) <= tolerance;
  /** Drag towards `target`; the rendered width must end at `expected`. */
  async function dragSidebar(target, expected, label) {
    await retry(async () => {
      const before = await panelWidth(".sidebar");
      await dragSidebarHandle(target - before);
      const after = await panelWidth(".sidebar");
      if (!near(after, expected)) throw new Error(`${label}: ${after}px, want ${expected}px`);
    }, 5000, label);
    check(label, true);
  }
  async function expectWidth(selector, expected, label) {
    await retry(async () => {
      const width = await panelWidth(selector);
      if (!near(width, expected)) throw new Error(`${label}: ${width}px, want ${expected}px`);
    }, 5000, label);
    check(label, true);
  }

  const bootWidth = await panelWidth(".sidebar");
  check("sidebar boots at the default width", near(bootWidth, 232), `${bootWidth}px`);
  await dragSidebar(292, 292, "drag widens the sidebar");
  await dragSidebar(100, 180, "drag below the minimum clamps at 180");
  await dragSidebar(500, 420, "drag past the maximum clamps at 420");

  // Mark the live page, reload, then wait until the mark is GONE plus the
  // demo story is back — evaluating against the pre-navigation document
  // otherwise passes instantly and races the fresh mount.
  await cdp.evaluate("window.__guiPreReload = true");
  await cdp.send("Page.reload");
  await retry(async () => {
    const reboot = await cdp.evaluate(`({
      stale: Boolean(window.__guiPreReload),
      turns: document.querySelectorAll(".turn").length,
      sidebar: Boolean(document.querySelector(".sidebar")),
    })`);
    if (reboot.stale || reboot.turns < 2 || !reboot.sidebar) {
      throw new Error(`reboot incomplete: ${JSON.stringify(reboot)}`);
    }
  }, 30_000, "renderer reboot after reload");
  const reloadedWidth = await panelWidth(".sidebar");
  check("reload restores the dragged width", near(reloadedWidth, 420), `${reloadedWidth}px`);

  const canvasBefore = await panelWidth(".viewport");
  await dblclickSidebarHandle();
  await expectWidth(".sidebar", 0, "double-click collapses the sidebar");
  await retry(async () => {
    const grown = await panelWidth(".viewport");
    if (!near(grown, canvasBefore + 420, 4)) {
      throw new Error(`canvas did not absorb the freed pixels: ${grown}px, want ${canvasBefore + 420}px`);
    }
  }, 5000, "canvas absorbs the freed pixels");
  await dblclickSidebarHandle();
  await expectWidth(".sidebar", 420, "double-click restores the sidebar");
  await retry(async () => {
    const back = await panelWidth(".viewport");
    if (!near(back, canvasBefore, 4)) throw new Error(`canvas did not return the pixels: ${back}px`);
  }, 5000, "canvas returns the pixels on expand");
} catch (error) {
  failures += 1;
  console.error(`  ✗ ${error.message}`);
}
console.log(failures === 0 ? "gui smoke: all checks passed" : `gui smoke: ${failures} check(s) failed`);
await cleanup(failures === 0 ? 0 : 1);
