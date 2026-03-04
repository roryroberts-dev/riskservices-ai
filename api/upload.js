// ============================================================
// BUILDMYSITE — Image Upload Handler
// Accepts image uploads (logo, hero), commits to GitHub repo
// via Contents API. Returns relative URL for the site.
// ============================================================

// Rate limiting
const uploads = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 300_000; // 5 minutes

function isRateLimited(ip) {
  const now = Date.now();
  const record = uploads.get(ip);
  if (!record || now - record.firstAt > RATE_WINDOW) {
    uploads.set(ip, { count: 1, firstAt: now });
    return false;
  }
  record.count++;
  return record.count > RATE_LIMIT;
}

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'];
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  // Rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many uploads. Please wait a few minutes.' });
  }

  // Auth check
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken || token !== adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Check GitHub config
  const ghToken = process.env.GITHUB_TOKEN;
  const ghRepo = process.env.GITHUB_REPO;

  if (!ghToken || !ghRepo) {
    return res.status(500).json({
      error: 'GitHub not configured',
      hint: 'Set GITHUB_TOKEN and GITHUB_REPO in your Vercel project settings.'
    });
  }

  try {
    const contentType = req.headers['content-type'] || '';

    if (!ALLOWED_TYPES.includes(contentType.split(';')[0])) {
      return res.status(400).json({
        error: `Invalid file type: ${contentType}. Allowed: ${ALLOWED_TYPES.join(', ')}`
      });
    }

    const filename = req.query.filename || req.headers['x-filename'] || `upload-${Date.now()}`;

    // Read body as buffer
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    if (body.length > MAX_SIZE) {
      return res.status(400).json({ error: `File too large: ${(body.length / 1024 / 1024).toFixed(1)}MB (max 5MB)` });
    }

    if (body.length === 0) {
      return res.status(400).json({ error: 'Empty file' });
    }

    const base64Content = body.toString('base64');
    const path = `images/${filename}`;
    const apiUrl = `https://api.github.com/repos/${ghRepo}/contents/${path}`;
    const headers = {
      Authorization: `token ${ghToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };

    // Check if file already exists (need SHA to update)
    let sha;
    const existing = await fetch(apiUrl, { headers });
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
    }

    // Commit to GitHub
    const commitBody = {
      message: `Upload ${filename}`,
      content: base64Content,
      branch: 'main',
    };
    if (sha) commitBody.sha = sha;

    const commitRes = await fetch(apiUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify(commitBody),
    });

    if (!commitRes.ok) {
      const err = await commitRes.json();
      throw new Error(err.message || 'GitHub commit failed');
    }

    return res.status(200).json({
      url: `/${path}`,
      size: body.length,
      filename,
    });

  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({
      error: 'Upload failed',
      hint: err.message
    });
  }
}
