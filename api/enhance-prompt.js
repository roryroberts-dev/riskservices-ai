// ============================================================
// PROMPT ENHANCER
// Converts casual user requests into structured agent prompts.
// Uses Gemini Flash for speed and cost (~$0.0003 per call).
// ============================================================

const ENHANCE_MODEL = 'gemini-2.5-flash';
const ENHANCE_COST = { input: 0.15, output: 0.60 }; // per 1M tokens

function calcCost(promptTokens, completionTokens) {
  return (promptTokens * ENHANCE_COST.input + completionTokens * ENHANCE_COST.output) / 1_000_000;
}

// Extract :root { ... } blocks from CSS
function extractCssVariables(css) {
  const blocks = [];
  const re = /:root\s*\{[^}]*\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    blocks.push(m[0]);
  }
  return blocks.join('\n\n') || '(no :root variables found)';
}

// Extract <nav>...</nav> from HTML
function extractNav(html) {
  const m = html.match(/<nav[\s\S]*?<\/nav>/i);
  return m ? m[0] : '(no nav found)';
}

// Extract <title> content
function extractTitle(html) {
  const m = html.match(/<title>(.*?)<\/title>/i);
  return m ? m[1] : '(no title)';
}

// Fetch a file from GitHub, return content or null on 404
async function fetchGitHubFile(repo, branch, path, headers) {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
      { headers }
    );
    if (!r.ok) return null;
    const data = await r.json();
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}

// Fetch the repo file tree
async function fetchFileTree(repo, branch, headers) {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`,
      { headers }
    );
    const data = await r.json();
    return (data.tree || []).filter(f => f.type === 'blob').map(f => f.path);
  } catch {
    return [];
  }
}

function buildMetaPrompt(fileList, cssVars, navHtml, pageTitle) {
  return `You are a prompt compiler for a website-building AI agent.

The agent has these tools: read_file, write_file, delete_file, list_files.
The agent has a 60-second timeout. It must finish in 3 reads + 2 writes max.

Your job: take the user's casual request and convert it into a precise, structured agent prompt.

## Site context

Files in repo:
${fileList.join('\n')}

CSS design system variables:
${cssVars}

Current nav structure:
${navHtml}

Page title: ${pageTitle}

## Rules for the enhanced prompt

1. ALWAYS start with "Read [file1] and [file2]" — name the exact files the agent needs.
2. Name specific CSS classes to preserve (from the nav, footer, design system).
3. Limit scope: max 3 reads + 2 writes. If the request is large, focus on the most important page and say "repeat for others in a follow-up".
4. Include this line: "Do NOT change nav structure, footer structure, or CSS class names."
5. For color/theme changes: instruct to ONLY modify CSS variables in css/style.css :root block. Never touch HTML.
6. For content changes: name the specific HTML section classes to find and edit.
7. For new pages: instruct to read an existing page as template + read index.html for nav/footer consistency.
8. Be specific about what to change and what to preserve.
9. Output ONLY the enhanced prompt text. No explanation, no preamble.
10. Keep the enhanced prompt under 500 words.`;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Auth check
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken || token !== adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { message } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  const apiKey = process.env.AI_API_KEY;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const ghToken = process.env.GITHUB_TOKEN;

  if (!apiKey || !repo || !ghToken) {
    return res.status(500).json({ error: 'Missing environment variables' });
  }

  const ghHeaders = {
    'Authorization': `Bearer ${ghToken}`,
    'Accept': 'application/vnd.github.v3+json'
  };

  try {
    // Three parallel GitHub fetches
    const [fileList, cssContent, indexContent] = await Promise.all([
      fetchFileTree(repo, branch, ghHeaders),
      fetchGitHubFile(repo, branch, 'css/style.css', ghHeaders),
      fetchGitHubFile(repo, branch, 'index.html', ghHeaders)
    ]);

    const cssVars = cssContent ? extractCssVariables(cssContent) : '(no CSS file yet)';
    const navHtml = indexContent ? extractNav(indexContent) : '(no index.html yet)';
    const pageTitle = indexContent ? extractTitle(indexContent) : '(no title)';

    const metaPrompt = buildMetaPrompt(fileList, cssVars, navHtml, pageTitle);

    // Call Gemini Flash via OpenAI-compatible endpoint
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: ENHANCE_MODEL,
        messages: [
          { role: 'system', content: metaPrompt },
          { role: 'user', content: message }
        ],
        temperature: 0.3,
        max_tokens: 2048
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Gemini ${r.status}: ${errText}`);
    }

    const data = await r.json();
    const enhancedPrompt = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};
    const cost = calcCost(usage.prompt_tokens || 0, usage.completion_tokens || 0);

    return res.status(200).json({
      enhancedPrompt,
      originalMessage: message,
      model: ENHANCE_MODEL,
      costUsd: Math.round(cost * 10000) / 10000
    });

  } catch (err) {
    console.error('Enhance error:', err);
    return res.status(500).json({ error: err.message });
  }
}
