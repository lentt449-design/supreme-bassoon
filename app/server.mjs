#!/usr/bin/env node
/**
 * 本地工作台服务:网页点按钮 → 调用本机 claude / codex CLI 跑对应 skill。
 * 零依赖,只用 Node 标准库。启动:node app/server.mjs  → http://127.0.0.1:8788
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'app');
const WS_DIR = path.join(ROOT, 'workspaces');
const PORT = 8788;

fs.mkdirSync(WS_DIR, { recursive: true });

// ---------- 五步流水线定义 ----------
const STEPS = [
  { id: 'outline',    n: 1, name: '改编大纲', skill: 'novel-outline',    done: f => f.some(x => x.endsWith('-outline.json')) },
  { id: 'characters', n: 2, name: '角色设定', skill: 'novel-characters', done: f => f.some(x => x.endsWith('-cast.json')) },
  { id: 'art',        n: 3, name: '美术设定', skill: 'novel-art',        done: f => f.some(x => x.endsWith('-art.json')) },
  { id: 'script',     n: 4, name: '剧本',     skill: 'novel-script',     done: f => f.some(x => x.endsWith('-script.json')) },
  { id: 'storyboard', n: 5, name: '分镜',     skill: 'novel-storyboard', done: f => f.some(x => x.endsWith('-storyboard.json')) },
];
const PREREQ = {
  outline:    () => null,
  characters: files => files.some(x => x.endsWith('-outline.json')) ? null : '需要先完成第 1 步(改编大纲)',
  art:        files => files.some(x => x.endsWith('-outline.json')) ? null : '需要先完成第 1 步(改编大纲)',
  script:     files => files.some(x => x.endsWith('-outline.json')) ? null : '需要先完成第 1 步(改编大纲)',
  storyboard: files => files.some(x => x.endsWith('-script.json')) ? null : '需要先完成第 4 步(剧本)',
};

const prompts = {
  outline:    p => `使用 novel-outline 技能:读取当前目录的 novel.txt,把小说改编成短剧大纲。所有产物(<剧名>-outline.json / .md / -report.html)直接生成到当前目录,不要建子目录。完成后回复一行 DONE。`,
  characters: p => `使用 novel-characters 技能:基于当前目录下的 *-outline.json 生成角色设定集,产物(<剧名>-cast.json / .md / -report.html)写到当前目录。完成后回复一行 DONE。`,
  art:        p => `使用 novel-art 技能:基于当前目录下的 *-outline.json 生成美术设定集(场景+叙事道具),产物(<剧名>-art.json / .md / -report.html)写到当前目录。完成后回复一行 DONE。`,
  script:     p => `使用 novel-script 技能:基于当前目录的大纲产物(*-outline.json)写剧本,产物(<剧名>-script.json / .md / -report.html)写到当前目录。完成后回复一行 DONE。`,
  storyboard: p => `使用 novel-storyboard 技能:基于当前目录的 *-script.json 出分镜,产物(<剧名>-storyboard.json / .md / -report.html)写到当前目录。完成后回复一行 DONE。`,
};

// ---------- 任务状态 ----------
let job = null; // { project, step, proc, startedAt }
let lastFinish = null; // { key, ok }
const logs = new Map(); // `${project}/${step}` -> string[]

function log(project, step, line) {
  const k = `${project}/${step}`;
  if (!logs.has(k)) logs.set(k, []);
  const arr = logs.get(k);
  arr.push(line);
  if (arr.length > 800) arr.splice(0, arr.length - 800);
}

function projectDir(p) {
  const d = path.join(WS_DIR, path.basename(p));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function listFiles(p) {
  try { return fs.readdirSync(projectDir(p)); } catch { return []; }
}
function stepState(p, step) {
  const files = listFiles(p);
  if (job && job.project === p && job.step === step) return 'running';
  if (job && job.project === p) return 'busy'; // 同项目其他步运行中
  if (step.done(files)) return 'done';
  if (job) return 'busy';                      // 全局同时只跑一个任务
  return PREREQ[step.id](files) ? 'locked' : 'ready';
}

function detectAgent(pref) {
  const cand = pref && pref !== 'auto' ? [pref] : ['claude', 'codex'];
  return new Promise(resolve => {
    let i = 0;
    const next = () => {
      if (i >= cand.length) return resolve(null);
      const name = cand[i++];
      const probe = spawn(name, ['--version'], { shell: true, stdio: 'ignore' });
      probe.on('error', () => next());
      probe.on('exit', code => (code === 0 ? resolve(name) : next()));
    };
    next();
  });
}
let agentCache = { name: null, at: 0 };
async function getAgentCached() {
  if (Date.now() - agentCache.at < 30000) return agentCache.name;
  agentCache = { name: await detectAgent('auto'), at: Date.now() };
  return agentCache.name;
}

function runStep(project, stepId, agentPref, cb) {
  const step = STEPS.find(s => s.id === stepId);
  const dir = projectDir(project);
  detectAgent(agentPref).then(agent => {
    if (!agent) {
      const msg = '未检测到 claude 或 codex CLI。请先安装并登录其中一个:\n  npm install -g @anthropic-ai/claude-code   (需 Claude 账号)\n  npm install -g @openai/codex          (需 ChatGPT 账号)';
      log(project, stepId, '[错误] ' + msg);
      lastFinish = { key: `${project}/${stepId}`, ok: false };
      return cb(new Error(msg));
    }
    lastFinish = null;
    const prompt = prompts[stepId](project);
    const args = agent === 'claude'
      ? ['-p', prompt, '--dangerously-skip-permissions']
      : ['exec', '--full-auto', prompt];
    log(project, stepId, `$ ${agent} ${args.join(' ')}`);
    log(project, stepId, `(工作目录: ${dir})`);
    const proc = spawn(agent, args, { cwd: dir, shell: true });
    job = { project, step: stepId, proc, startedAt: Date.now() };
    proc.stdout.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && log(project, stepId, l)));
    proc.stderr.on('data', d => d.toString().split(/\r?\n/).forEach(l => l && log(project, stepId, '[stderr] ' + l)));
    proc.on('error', e => { job = null; log(project, stepId, '[启动失败] ' + e.message); cb(e); });
    proc.on('exit', (code, sig) => {
      job = null;
      const ok = code === 0;
      lastFinish = { key: `${project}/${stepId}`, ok };
      log(project, stepId, ok
        ? `[完成] ${step.name} 退出码 0。产物: ${listFiles(project).join(', ') || '(未检测到新文件)'}`
        : `[失败] 退出码 ${code} ${sig || ''}`);
      cb(null, ok);
    });
  });
}

// ---------- HTTP ----------
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 20 * 1024 * 1024) reject(new Error('body too large')); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
function serveFile(res, filePath) {
  fs.readFile(filePath, (e, data) => {
    if (e) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;

  // API
  if (p === '/api/steps' && req.method === 'GET') {
    if (!fs.existsSync(WS_DIR)) fs.mkdirSync(WS_DIR, { recursive: true });
    const projects = fs.readdirSync(WS_DIR).filter(f => fs.statSync(path.join(WS_DIR, f)).isDirectory());
    const agent = await getAgentCached();
    return json(res, 200, {
      steps: STEPS.map(s => ({ id: s.id, n: s.n, name: s.name, skill: s.skill })),
      agent,
      projects: projects.map(name => ({
        name,
        files: listFiles(name),
        states: Object.fromEntries(STEPS.map(s => [s.id, stepState(name, s)])),
        lockReason: PREREQ.outline(listFiles(name)),
      })),
      running: job ? { project: job.project, step: job.step } : null,
    });
  }
  if (p === '/api/project' && req.method === 'POST') {
    const { name, novel } = JSON.parse(await readBody(req));
    const safe = (name || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60);
    if (!safe) return json(res, 400, { error: '项目名不能为空' });
    if (!novel || novel.trim().length < 50) return json(res, 400, { error: '小说内容太短(至少 50 字)' });
    fs.writeFileSync(path.join(projectDir(safe), 'novel.txt'), novel, 'utf8');
    return json(res, 200, { ok: true, name: safe });
  }
  if (p === '/api/run' && req.method === 'POST') {
    if (job) return json(res, 409, { error: `有任务正在运行(${job.project} / 第 ${STEPS.find(s => s.id === job.step).n} 步),请等它结束` });
    const { project, step, agent } = JSON.parse(await readBody(req));
    const st = STEPS.find(s => s.id === step);
    if (!st || !fs.existsSync(path.join(WS_DIR, path.basename(project || '')))) return json(res, 400, { error: '参数不对' });
    const lock = PREREQ[step](listFiles(project));
    if (lock) return json(res, 400, { error: lock });
    runStep(project, step, agent || 'auto', () => {});
    return json(res, 200, { ok: true });
  }
  if (p === '/api/log' && req.method === 'GET') {
    const project = url.searchParams.get('project') || '';
    const step = url.searchParams.get('step') || '';
    const k = `${project}/${step}`;
    return json(res, 200, {
      lines: logs.get(k) || [],
      running: !!(job && job.project === project && job.step === step),
      finished: lastFinish && lastFinish.key === k ? lastFinish : null,
    });
  }
  if (p === '/api/assemble' && req.method === 'POST') {
    const { project } = JSON.parse(await readBody(req));
    const dir = projectDir(project);
    return new Promise(resolve => {
      const proc = spawn('node', [path.join(ROOT, 'scripts', 'report.mjs'), '--from', dir, '--out', path.join(dir, 'report.html')], { shell: true });
      let out = '';
      proc.stdout.on('data', d => out += d);
      proc.stderr.on('data', d => out += d);
      proc.on('exit', code => { json(res, code === 0 ? 200 : 500, { ok: code === 0, output: out.slice(-2000) }); resolve(); });
    });
  }
  if (p.startsWith('/ws/') && req.method === 'GET') {
    const rel = decodeURIComponent(p.slice(4)).replace(/\.\./g, '');
    return serveFile(res, path.join(WS_DIR, rel));
  }

  // 静态页面
  if (p === '/' || p === '/index.html') return serveFile(res, path.join(APP_DIR, 'index.html'));
  res.writeHead(404); res.end('404');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`工作台已启动: http://127.0.0.1:${PORT}`);
  console.log(`工作区目录: ${WS_DIR}`);
});
