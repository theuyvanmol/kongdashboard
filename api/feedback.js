// Vercel serverless function: turns dashboard feedback into GitHub issues.
// Needs env vars in Vercel: GITHUB_TOKEN (fine-grained PAT, Issues read/write on this repo only).
// Optional: GITHUB_REPO (default theuyvanmol/kongdashboard).
const REPO = process.env.GITHUB_REPO || 'theuyvanmol/kongdashboard';
const hits = new Map(); // best-effort in-memory rate limit per warm instance

async function gh(path, opts = {}) {
  const r = await fetch('https://api.github.com/repos/' + REPO + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'kong-dashboard', 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'GitHub ' + r.status);
  return j;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.GITHUB_TOKEN) return res.status(503).json({ error: 'Feedback is not connected to GitHub yet (GITHUB_TOKEN missing).' });
  try {
    if (req.method === 'GET') {
      const list = await gh('/issues?labels=from-dashboard&state=all&per_page=30');
      const items = list.filter(i => !i.pull_request).map(i => {
        const names = i.labels.map(l => l.name);
        return { number: i.number, title: i.title, kind: names.includes('bug') ? 'bug' : 'feature', status: i.state === 'closed' ? 'done' : (names.includes('fix') ? 'progress' : 'received') };
      });
      return res.status(200).json({ items });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.website) return res.status(200).json({ ok: true }); // honeypot: silently drop bots
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0] || 'x';
    const now = Date.now(); const arr = (hits.get(ip) || []).filter(t => now - t < 3600e3);
    if (arr.length >= 10) return res.status(429).json({ error: 'Too many requests — try again later.' });
    arr.push(now); hits.set(ip, arr);
    const title = String(b.title || '').trim().slice(0, 120);
    const desc = String(b.description || '').trim().slice(0, 3000);
    const name = String(b.name || '').trim().slice(0, 60);
    const kind = b.type === 'feature' ? 'feature' : 'bug';
    if (title.length < 4 || desc.length < 10) return res.status(400).json({ error: 'Please add a title and more detail.' });
    const issue = await gh('/issues', { method: 'POST', body: JSON.stringify({
      title: (kind === 'bug' ? '[Bug] ' : '[Feature] ') + title,
      body: desc + '\n\n---\nSubmitted from the Kong dashboard' + (name ? ' by ' + name : '') + '.',
      labels: ['from-dashboard', kind === 'bug' ? 'bug' : 'enhancement', kind === 'bug' ? 'bug' : 'feature'],
    }) });
    return res.status(200).json({ ok: true, number: issue.number });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
