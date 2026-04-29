import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import os from 'os';
import webpush from 'web-push';

const execAsync = promisify(exec);
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:you@example.com';

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error('Missing VAPID keys. Run: npm run setup');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

// In-memory push subscription store (one browser = one subscription)
const pushSubscriptions = new Set();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Keyed by session_id. Crash fallback TTL: 10 min.
const statusStore = new Map();
const STATUS_TTL = 600_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toolSummary(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return toolName;
  switch (toolName) {
    case 'Bash':       return `Bash: ${String(toolInput.command    || '').slice(0, 60)}`;
    case 'Read':       return `Read: ${path.basename(String(toolInput.file_path  || ''))}`;
    case 'Write':      return `Write: ${path.basename(String(toolInput.file_path || ''))}`;
    case 'Edit':       return `Edit: ${path.basename(String(toolInput.file_path  || ''))}`;
    case 'WebSearch':  return `Search: ${String(toolInput.query    || '').slice(0, 50)}`;
    case 'WebFetch':   return `Fetch: ${String(toolInput.url       || '').slice(0, 60)}`;
    case 'Agent':      return `Agent: ${String(toolInput.description || toolInput.subagent_type || '').slice(0, 50)}`;
    default:           return toolName;
  }
}

function pushActivity(session, icon, summary) {
  session.activity.unshift({ icon, summary: String(summary).slice(0, 80), ts: Date.now() });
  if (session.activity.length > 30) session.activity.length = 30;
}

function makeSession(cwd, now) {
  return {
    cwd,
    status: 'idle',
    startedAt: now,
    updatedAt: now,
    currentTool: null,
    subagents: [],        // [{ type, status:'active'|'done', startedAt, endedAt? }]
    tasks: {},            // { [id]: { title, status:'pending'|'done' } }
    activity: [],         // [{ icon, summary, ts }]  newest-first, max 30
    notifications: [],    // [{ content, ts }]  max 5
  };
}

// ─── Push notifications ───────────────────────────────────────────────────────

app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  // Deduplicate by endpoint
  for (const existing of pushSubscriptions) {
    if (existing.endpoint === sub.endpoint) { pushSubscriptions.delete(existing); break; }
  }
  pushSubscriptions.add(sub);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  for (const sub of pushSubscriptions) {
    if (sub.endpoint === endpoint) { pushSubscriptions.delete(sub); break; }
  }
  res.json({ ok: true });
});

async function sendPush(title, body, data = {}) {
  if (!pushSubscriptions.size) return;
  const payload = JSON.stringify({ title, body, ...data });
  const dead = [];
  for (const sub of pushSubscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) dead.push(sub); // expired
    }
  }
  dead.forEach(s => pushSubscriptions.delete(s));
}

// ─── Hook endpoint ────────────────────────────────────────────────────────────

app.post('/api/hook', (req, res) => {
  const { event, session_id, cwd, data } = req.body;
  if (!session_id || !event) return res.status(400).json({ error: 'missing fields' });

  const now = Date.now();
  let session = statusStore.get(session_id) || makeSession(cwd || 'unknown', now);

  session.updatedAt = now;
  if (cwd) session.cwd = cwd;

  switch (event) {

    case 'SessionStart':
      session.status = 'idle';
      session.startedAt = now;
      pushActivity(session, '◎', `Started (${data?.source || 'new'})`);
      break;

    case 'SessionEnd':
      session.status = 'ended';
      pushActivity(session, '◎', 'Session ended');
      setTimeout(() => statusStore.delete(session_id), 8000);
      break;

    case 'UserPromptSubmit':
      session.status = 'thinking';
      session.currentTool = null;
      pushActivity(session, '◌', 'Processing…');
      break;

    case 'PreToolUse': {
      const toolName = data?.tool_name || 'tool';
      session.status = 'working';
      session.currentTool = toolName;
      pushActivity(session, '→', toolSummary(toolName, data?.tool_input));
      break;
    }

    case 'PostToolUse': {
      const toolName = data?.tool_name || 'tool';
      session.currentTool = null;
      pushActivity(session, '✓', toolName);
      break;
    }

    case 'Stop':
      session.status = 'idle';
      session.currentTool = null;
      pushActivity(session, '■', 'Response complete');
      break;

    case 'PermissionRequest':
      session.status = 'waiting';
      pushActivity(session, '⚠', `Permission: ${data?.tool_name || 'tool'}`);
      sendPush(
        path.basename(session.cwd),
        `Needs your input to use ${data?.tool_name || 'a tool'}`,
        { url: 'http://localhost:4242', session_id }
      );
      break;

    case 'SubagentStart': {
      const agentType = data?.agent_type || 'agent';
      session.subagents.push({ type: agentType, status: 'active', startedAt: now });
      pushActivity(session, '⎇', `Spawned ${agentType}`);
      break;
    }

    case 'SubagentStop': {
      const agentType = data?.agent_type || 'agent';
      for (let i = session.subagents.length - 1; i >= 0; i--) {
        if (session.subagents[i].type === agentType && session.subagents[i].status === 'active') {
          session.subagents[i].status = 'done';
          session.subagents[i].endedAt = now;
          break;
        }
      }
      pushActivity(session, '⎇', `Done ${agentType}`);
      break;
    }

    case 'TaskCreated': {
      const taskId = String(data?.id || data?.task_id || now);
      const title = String(data?.title || data?.description || 'Task').slice(0, 60);
      session.tasks[taskId] = { title, status: 'pending', createdAt: now };
      pushActivity(session, '◉', `Task: ${title}`);
      break;
    }

    case 'TaskCompleted': {
      const taskId = String(data?.id || data?.task_id || '');
      if (taskId && session.tasks[taskId]) {
        session.tasks[taskId].status = 'done';
        session.tasks[taskId].completedAt = now;
      }
      const title = (taskId && session.tasks[taskId]?.title) || data?.title || 'Task';
      pushActivity(session, '✓', `Done: ${String(title).slice(0, 60)}`);
      break;
    }

    case 'Notification': {
      const content = String(data?.content || data?.notification_type || 'Notification').slice(0, 120);
      session.notifications.unshift({ content, ts: now });
      if (session.notifications.length > 5) session.notifications.length = 5;
      pushActivity(session, '🔔', content.slice(0, 60));
      sendPush(
        path.basename(session.cwd),
        content,
        { url: 'http://localhost:4242', session_id }
      );
      break;
    }

    case 'CwdChanged':
      if (data?.new_cwd) session.cwd = data.new_cwd;
      pushActivity(session, '⇢', `cd ${path.basename(data?.new_cwd || '')}`);
      break;
  }

  statusStore.set(session_id, session);
  res.json({ ok: true });
});

// ─── PS discovery (for listing only, not status) ──────────────────────────────

let psCache = []; // [{ pid, cwd }]

async function refreshPsCache() {
  try {
    const { stdout } = await execAsync(`ps -A -o pid,command | awk '$2=="claude" {print $1}'`);
    const pids = stdout.trim().split('\n').filter(Boolean).map(s => s.trim());
    const results = await Promise.all(pids.map(async pid => {
      try {
        const { stdout: cwdOut } = await execAsync(`lsof -p ${pid} | awk '$4=="cwd" {print $9}'`);
        const cwd = cwdOut.trim();
        return cwd ? { pid, cwd } : null;
      } catch { return null; }
    }));
    psCache = results.filter(Boolean);
  } catch {
    psCache = [];
  }
}

// Refresh every 5 s in background — never blocks a request
refreshPsCache();
setInterval(refreshPsCache, 5000);

// ─── Sessions ─────────────────────────────────────────────────────────────────

app.get('/api/sessions', (req, res) => {
  const now = Date.now();
  const sessions = [];

  // 1. Hook-tracked sessions (authoritative for status)
  const hookedCwds = new Set();
  for (const [session_id, entry] of statusStore.entries()) {
    if (entry.status !== 'ended' && now - entry.updatedAt > STATUS_TTL) {
      statusStore.delete(session_id); continue;
    }
    if (entry.status === 'ended') continue;
    hookedCwds.add(entry.cwd);
    const activeSubagents = entry.subagents.filter(s => s.status === 'active');
    const allTasks = Object.values(entry.tasks);
    sessions.push({
      session_id,
      cwd: entry.cwd,
      status: entry.status,
      source: 'hook',
      startedAt: entry.startedAt,
      updatedAt: entry.updatedAt,
      currentTool: entry.currentTool,
      subagents: { active: activeSubagents.length, types: activeSubagents.map(s => s.type), total: entry.subagents.length },
      tasks: { total: allTasks.length, done: allTasks.filter(t => t.status === 'done').length },
      activity: entry.activity.slice(0, 6),
      notifications: entry.notifications,
    });
  }

  // 2. PS-discovered sessions not yet seen by any hook
  for (const { pid, cwd } of psCache) {
    if (hookedCwds.has(cwd)) continue; // already covered by hook data
    sessions.push({
      session_id: `ps:${pid}`,
      cwd,
      status: 'idle',
      source: 'ps',
      startedAt: null,
      updatedAt: now,
      currentTool: null,
      subagents: { active: 0, types: [], total: 0 },
      tasks: { total: 0, done: 0 },
      activity: [],
      notifications: [],
    });
  }

  res.json({ sessions, updatedAt: new Date().toISOString() });
});

// ─── Kill ──────────────────────────────────────────────────────────────────────

app.post('/api/kill', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'missing session_id' });

  let pid = null;

  if (session_id.startsWith('ps:')) {
    // PS-discovered session — PID is right there in the id
    pid = session_id.slice(3);
  } else {
    const entry = statusStore.get(session_id);
    if (!entry) return res.status(404).json({ error: 'session not found' });
    // Find the PID by matching cwd in ps cache first (fast), then fall back to lsof scan
    const cached = psCache.find(s => s.cwd === entry.cwd);
    if (cached) {
      pid = cached.pid;
    } else {
      try {
        const { stdout } = await execAsync(`ps -A -o pid,command | awk '$2=="claude" {print $1}'`);
        const pids = stdout.trim().split('\n').filter(Boolean);
        for (const p of pids) {
          try {
            const { stdout: cwdOut } = await execAsync(`lsof -p ${p.trim()} | awk '$4=="cwd" {print $9}'`);
            if (cwdOut.trim() === entry.cwd) { pid = p.trim(); break; }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
    statusStore.delete(session_id);
  }

  if (pid) {
    try { await execAsync(`kill -TERM ${pid}`); } catch { /* already dead */ }
    // Remove from ps cache immediately so it doesn't reappear before next refresh
    psCache = psCache.filter(s => s.pid !== pid);
  }

  res.json({ ok: true, pid });
});

// ─── Files ─────────────────────────────────────────────────────────────────────

const BASE_DIR = process.env.BASE_DIR || os.homedir();

app.get('/api/config', (req, res) => {
  res.json({ baseDir: BASE_DIR });
});

app.get('/api/files', async (req, res) => {
  const requestedPath = req.query.path ? path.resolve(req.query.path) : BASE_DIR;
  if (!requestedPath.startsWith(BASE_DIR)) return res.status(403).json({ error: 'Access denied' });
  try {
    const entries = await fs.readdir(requestedPath, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: path.join(requestedPath, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: requestedPath, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/launch-claude', async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath || !dirPath.startsWith(BASE_DIR)) return res.status(403).json({ error: 'Invalid path' });
  const escaped = dirPath.replace(/"/g, '\\"');
  const script = `tell application "Terminal"\n  do script "cd \\"${escaped}\\" && claude"\n  activate\nend tell`;
  try {
    await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/reveal', async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath || !dirPath.startsWith(BASE_DIR)) return res.status(403).json({ error: 'Invalid path' });
  try {
    await execAsync(`open "${dirPath.replace(/"/g, '\\"')}"`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 4242;
app.listen(PORT, () => console.log(`Claude HQ running at http://localhost:${PORT}`));
