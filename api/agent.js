// ============================================================
// BUILDMYSITE AGENT
// AI-powered website builder and modifier.
// Supports: Anthropic (Claude), OpenAI (GPT), Google (Gemini)
// ============================================================

// ---- Approved models (top-tier only) ------------------------
const APPROVED_MODELS = {
  'claude-opus-4-6':     { provider: 'anthropic', maxTokens: 8096 },
  'claude-sonnet-4-6':   { provider: 'anthropic', maxTokens: 8096 },
  'gpt-5.2':             { provider: 'openai',    maxTokens: 16384 },
  'gemini-3.1-pro':      { provider: 'google',    maxTokens: 32768 },
  'gemini-2.5-flash':    { provider: 'google',    maxTokens: 65536 },
  'gemini-3.0-flash':    { provider: 'google',    maxTokens: 32768 },
};

// ---- Cost table (USD per 1M tokens) -------------------------
const COSTS = {
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input:  3.00, output: 15.00 },
  'gpt-5.2':           { input:  3.00, output: 15.00 },
  'gemini-3.1-pro':    { input:  2.00, output: 12.00 },
  'gemini-2.5-flash':  { input:  0.15, output:  0.60 },
  'gemini-3.0-flash':  { input:  0.50, output:  3.00 },
};

function calcCost(model, promptTokens, completionTokens) {
  const c = COSTS[model] || { input: 0, output: 0 };
  return (promptTokens * c.input + completionTokens * c.output) / 1_000_000;
}

// ---- Tool definitions ---------------------------------------
const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the website repo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, e.g. index.html or css/style.css' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or update a file in the website repo. Commits to GitHub and triggers auto-deploy via Vercel.',
    parameters: {
      type: 'object',
      properties: {
        path:           { type: 'string', description: 'File path' },
        content:        { type: 'string', description: 'Full file content' },
        commit_message: { type: 'string', description: 'Short description of the change' }
      },
      required: ['path', 'content', 'commit_message']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the website repo.',
    parameters: {
      type: 'object',
      properties: {
        path:           { type: 'string', description: 'File path to delete' },
        commit_message: { type: 'string', description: 'Reason for deletion' }
      },
      required: ['path', 'commit_message']
    }
  },
  {
    name: 'list_files',
    description: 'List all files in the website repo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path to filter by, or empty for all files' }
      }
    }
  }
];

// ---- GitHub API helpers -------------------------------------
function makeGitHub(env) {
  const { GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH } = env;
  const branch = GITHUB_BRANCH || 'main';
  const headers = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };

  return {
    async get(path) {
      const r = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${branch}`,
        { headers }
      );
      if (!r.ok) throw new Error(`GitHub GET ${path}: ${r.status}`);
      return r.json();
    },

    async put(path, content, message, sha) {
      const body = { message, content: Buffer.from(content).toString('base64'), branch };
      if (sha) body.sha = sha;
      const r = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
        { method: 'PUT', headers, body: JSON.stringify(body) }
      );
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`GitHub PUT ${path}: ${r.status} ${t}`);
      }
      return r.json();
    },

    async del(path, message, sha) {
      const r = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
        { method: 'DELETE', headers, body: JSON.stringify({ message, sha, branch }) }
      );
      if (!r.ok) throw new Error(`GitHub DELETE ${path}: ${r.status}`);
      return { deleted: path };
    },

    async listTree() {
      const r = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/git/trees/${branch}?recursive=1`,
        { headers }
      );
      const data = await r.json();
      return (data.tree || []).filter(f => f.type === 'blob').map(f => f.path);
    },

    // Batch commit multiple files in a single commit using Git Trees API
    async batchCommit(files, message) {
      // files: [{ path, content }]
      // 1. Get the current commit SHA for the branch
      const refR = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/git/ref/heads/${branch}`,
        { headers }
      );
      if (!refR.ok) throw new Error(`Failed to get branch ref: ${refR.status}`);
      const refData = await refR.json();
      const baseSha = refData.object.sha;

      // 2. Get the tree SHA from the base commit
      const commitR = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/git/commits/${baseSha}`,
        { headers }
      );
      if (!commitR.ok) throw new Error(`Failed to get base commit: ${commitR.status}`);
      const commitData = await commitR.json();
      const baseTreeSha = commitData.tree.sha;

      // 3. Create blobs for each file
      const treeEntries = [];
      for (const file of files) {
        const blobR = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/git/blobs`,
          {
            method: 'POST', headers,
            body: JSON.stringify({ content: file.content, encoding: 'utf-8' })
          }
        );
        if (!blobR.ok) throw new Error(`Failed to create blob for ${file.path}: ${blobR.status}`);
        const blobData = await blobR.json();
        treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blobData.sha });
      }

      // 4. Create a new tree
      const treeR = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/git/trees`,
        {
          method: 'POST', headers,
          body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries })
        }
      );
      if (!treeR.ok) throw new Error(`Failed to create tree: ${treeR.status}`);
      const treeData = await treeR.json();

      // 5. Create a new commit
      const newCommitR = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/git/commits`,
        {
          method: 'POST', headers,
          body: JSON.stringify({ message, tree: treeData.sha, parents: [baseSha] })
        }
      );
      if (!newCommitR.ok) throw new Error(`Failed to create commit: ${newCommitR.status}`);
      const newCommitData = await newCommitR.json();

      // 6. Update the branch ref
      const updateR = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/git/refs/heads/${branch}`,
        {
          method: 'PATCH', headers,
          body: JSON.stringify({ sha: newCommitData.sha })
        }
      );
      if (!updateR.ok) throw new Error(`Failed to update branch ref: ${updateR.status}`);

      return { sha: newCommitData.sha, filesCommitted: files.length };
    }
  };
}

// ---- Security helpers ---------------------------------------

const PROTECTED_PATHS = ['api/agent.js', 'api/contact.js', 'api/revert.js', 'admin.html', 'vercel.json', 'package.json', '.env'];
const MAX_FILE_SIZE = 500_000; // 500KB per file

// ---- Structural validation ----------------------------------
// Required CSS classes per page file. If the AI's output is missing any of these,
// the write is blocked before it reaches pendingWrites.
// These are the same classes listed in the page prompt constraints (setup.js).
const REQUIRED_CLASSES = {
  'index.html': ['nav', 'nav__inner', 'nav__brand', 'nav__links', 'nav__link', 'hero', 'container', 'footer', 'footer__brand', 'footer__bottom', 'footer__badge'],
  'contact.html': ['nav', 'nav__inner', 'nav__brand', 'contact-grid', 'contact-form', 'form-group', 'contact-info', 'footer'],
  'about.html': ['nav', 'nav__inner', 'nav__brand', 'section', 'container', 'footer'],
  'services.html': ['nav', 'nav__inner', 'nav__brand', 'hero--compact', 'grid', 'card', 'card__title', 'footer'],
  'gallery.html': ['nav', 'gallery-grid', 'gallery-item', 'gallery-item__caption', 'hero--compact', 'footer'],
  'menu.html': ['nav', 'menu-category', 'menu-item', 'menu-item__name', 'menu-item__price', 'hero--compact', 'footer'],
  'testimonials.html': ['nav', 'testimonial-card', 'testimonial-card__quote', 'testimonial-card__author', 'hero--compact', 'footer'],
  'faq.html': ['nav', 'faq-item', 'faq-item__question', 'faq-item__answer', 'hero--compact', 'footer'],
};

function validateStructure(filePath, content) {
  const requiredClasses = REQUIRED_CLASSES[filePath];
  if (!requiredClasses) return null; // No validation rules for this file

  const missing = [];
  for (const cls of requiredClasses) {
    // Check for the class name as a class attribute value or substring
    // Handles: class="nav", class="nav foo", class="foo nav bar"
    if (!content.includes(cls)) {
      missing.push(cls);
    }
  }

  if (missing.length > 0) {
    return `Build blocked: AI removed required structural classes from ${filePath}: ${missing.join(', ')}. The file was NOT committed.`;
  }
  return null;
}

function validatePath(path) {
  if (!path || typeof path !== 'string') throw new Error('Path is required');
  if (path.includes('..') || path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`Invalid path: ${path}`);
  }
  if (PROTECTED_PATHS.includes(path.toLowerCase())) {
    throw new Error(`Protected file: ${path} cannot be modified by the agent`);
  }
}

// ---- Rate limiting ------------------------------------------

const agentRequests = new Map();
const AGENT_RATE_LIMIT = 10;      // max requests
const AGENT_RATE_WINDOW = 300_000; // per 5 minutes

function isAgentRateLimited(ip) {
  const now = Date.now();
  const record = agentRequests.get(ip);
  if (!record || now - record.firstAt > AGENT_RATE_WINDOW) {
    agentRequests.set(ip, { count: 1, firstAt: now });
    return false;
  }
  record.count++;
  return record.count > AGENT_RATE_LIMIT;
}

// ---- Tool execution -----------------------------------------
// pendingWrites collects files during the agent loop; they are batch-committed at the end
async function executeTool(name, args, env, pendingWrites) {
  const gh = makeGitHub(env);

  switch (name) {
    case 'read_file': {
      validatePath(args.path);
      // Check pending writes first (agent may read a file it just wrote)
      const pending = pendingWrites.find(f => f.path === args.path);
      if (pending) {
        return { path: args.path, content: pending.content, size: pending.content.length, source: 'pending' };
      }
      const file = await gh.get(args.path);
      const content = Buffer.from(file.content, 'base64').toString('utf-8');
      return { path: args.path, content, size: content.length };
    }

    case 'write_file': {
      validatePath(args.path);
      let content = args.content || '';

      // Content size limit
      if (content.length > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${content.length} chars (max ${MAX_FILE_SIZE})`);
      }

      // Fix double-escaped newlines (some models mangle these)
      const realNL = (content.match(/\n/g) || []).length;
      const escapedNL = (content.match(/\\n/g) || []).length;
      if (escapedNL > 10 && realNL === 0) {
        content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\'/g, "'");
      }

      // Pre-commit validation: hard gate
      if (!content.trim()) {
        throw new Error(`Write blocked: content for ${args.path} is empty.`);
      }
      if (args.path.endsWith('.html') && !content.includes('<html') && !content.toLowerCase().includes('<!doctype')) {
        throw new Error(`Write blocked: ${args.path} is missing <!DOCTYPE html> or <html> root element.`);
      }

      // Structural validation: verify required CSS classes are preserved
      const structureError = validateStructure(args.path, content);
      if (structureError) {
        throw new Error(structureError);
      }

      // Stage the file for batch commit (replaces any previous pending write to same path)
      const existingIdx = pendingWrites.findIndex(f => f.path === args.path);
      if (existingIdx >= 0) {
        pendingWrites[existingIdx] = { path: args.path, content };
      } else {
        pendingWrites.push({ path: args.path, content });
      }

      return { staged: args.path, message: args.commit_message, chars: content.length };
    }

    case 'delete_file': {
      validatePath(args.path);
      const file = await gh.get(args.path);
      await gh.del(args.path, args.commit_message, file.sha);
      return { deleted: args.path, _pre_sha: file.sha };
    }

    case 'list_files': {
      const allFiles = await gh.listTree();
      const path = args.path || '';
      const files = path ? allFiles.filter(f => f.startsWith(path)) : allFiles;
      // Include any pending writes not yet on disk
      const pendingPaths = pendingWrites.map(f => f.path).filter(p => !files.includes(p));
      const combined = [...files, ...pendingPaths];
      return { files: combined, count: combined.length };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- Provider adapters --------------------------------------

async function callAnthropic(messages, systemPrompt, model, apiKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: APPROVED_MODELS[model]?.maxTokens || 8096,
      system: systemPrompt,
      messages,
      tools: TOOLS.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      }))
    })
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Anthropic ${r.status}: ${t}`); }
  const data = await r.json();

  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const toolCalls = data.content.filter(b => b.type === 'tool_use').map(b => ({
    id: b.id, name: b.name, args: b.input
  }));
  return {
    text,
    toolCalls,
    usage: { prompt: data.usage.input_tokens, completion: data.usage.output_tokens },
    stopReason: data.stop_reason
  };
}

async function callOpenAICompatible(messages, systemPrompt, model, apiKey, baseUrl, maxTokens) {
  const url = baseUrl + '/v1/chat/completions';
  const oaiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: JSON.stringify(m.content) };
      return { role: m.role, content: m.content, tool_calls: m.tool_calls };
    })
  ];

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: oaiMessages,
      tools: TOOLS.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      })),
      tool_choice: 'auto',
      max_tokens: maxTokens
    })
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`${model} ${r.status}: ${t}`); }
  const data = await r.json();
  const choice = data.choices[0];
  const msg = choice.message;

  if (choice.finish_reason === 'length') {
    throw new Error('Model hit output token limit mid-response. Try a simpler request.');
  }

  const text = msg.content || '';
  const toolCalls = (msg.tool_calls || []).map(tc => {
    let args;
    try {
      args = JSON.parse(tc.function.arguments || '{}');
    } catch (e) {
      throw new Error(`Tool call "${tc.function.name}" returned unparseable arguments: ${e.message}`);
    }
    return { id: tc.id, name: tc.function.name, args };
  });

  return {
    text,
    toolCalls,
    rawToolCalls: msg.tool_calls || [],
    usage: { prompt: data.usage?.prompt_tokens || 0, completion: data.usage?.completion_tokens || 0 },
    stopReason: choice.finish_reason
  };
}

// ---- Message format converters ------------------------------

function anthropicMessages(history) {
  // Anthropic format: { role: 'user'|'assistant', content: string|array }
  return history.map(m => {
    if (m.role === 'tool_result') {
      return {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_use_id,
          content: JSON.stringify(m.content)
        }]
      };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const tc of m.tool_calls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      return { role: 'assistant', content };
    }
    return { role: m.role, content: m.content || m.text || '' };
  });
}

function openaiMessages(history) {
  return history.map(m => {
    if (m.role === 'tool_result') {
      return { role: 'tool', tool_call_id: m.tool_use_id, content: JSON.stringify(m.content) };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      return {
        role: 'assistant',
        content: m.text || '',
        tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args) }
        }))
      };
    }
    return { role: m.role, content: m.content || m.text || '' };
  });
}

// ---- System prompt ------------------------------------------

function buildSystemPrompt(businessInfo, mode) {
  const info = businessInfo || {};
  const isBuild = mode === 'build';

  const businessBlock = [
    info.name        && `- Business name: ${info.name}`,
    info.description && `- Description: ${info.description}`,
    info.type        && `- Business type: ${info.type}`,
    info.email       && `- Email: ${info.email}`,
    info.phone       && `- Phone: ${info.phone}`,
    info.address     && `- Address: ${info.address}`,
    info.hours       && `- Opening hours: ${info.hours}`,
    info.services    && `- Services/Products: ${info.services}`,
    info.tagline     && `- Tagline: ${info.tagline}`,
    info.tone        && `- Brand tone: ${info.tone}`,
    info.logo_url    && `- Logo image URL: ${info.logo_url}`,
    info.hero_url    && `- Hero/banner image URL: ${info.hero_url}`,
    info.extra       && `- Additional info: ${info.extra}`,
  ].filter(Boolean).join('\n');

  const buildModeSection = `
## Build Mode — Initial Site Generation

You are creating a brand new website from scratch. Follow this exact sequence:

### Step 1: Read the Design System
Read css/style.css first. Understand the available CSS variables and classes.

### Step 2: Customise the Design System
Append business-appropriate CSS to the bottom of css/style.css (below the marked AI section).
Choose colours that suit the business type:
- Override --color-primary, --color-accent, --color-highlight in a new :root block
- Keep the base classes intact — only add overrides and new business-specific styles
- If the business has a specific industry (restaurant, trades, etc.), choose colours that feel right for that industry

### Step 3: Plan the Pages
Based on the business description, decide which pages to create. Every site gets:
- index.html (home page — hero, about preview, services preview, CTA)
- contact.html (contact form + business contact details)

Then add more based on the business:
- about.html — if the business has a story, team, or mission worth telling
- services.html — if they offer multiple distinct services
- menu.html — for restaurants/cafes
- gallery.html — if visual work matters (trades, photography, venues)
- pricing.html — if they have clear pricing tiers
- faq.html — if the business type commonly gets questions

Keep it focused. 3-5 pages total. Quality over quantity.

### Step 4: Build Each Page
Write pages one at a time. For each page:
1. Write the COMPLETE HTML file
2. Include the same nav on every page (highlight the current page with nav__link--active)
3. Include the same footer on every page
4. Use real, plausible content — NEVER use "Lorem ipsum" or "[Your text here]"
5. Write like a professional copywriter. Speak in the business's voice.
6. Every page must be self-contained (full <!DOCTYPE html> to </html>)
7. For every page, include:
   - A unique <title> tag with the business name (e.g. "Services — Murphy's Bakery")
   - A <meta name="description"> with a relevant 150-character summary
   - <meta property="og:title"> and <meta property="og:description"> for social sharing
8. If a logo_url was provided, add <link rel="icon" href="{logo_url}"> to every page

### Content Rules
- Write real copy. If the business is a bakery, talk about fresh bread, not placeholder text.
- Use specific, concrete language. "Fresh sourdough baked daily at 5am" not "We offer quality products".
- Match the tone to the business type: warm for hospitality, confident for professional services, practical for trades.
- Use the business name in headings and page titles.
- For services/menu items, invent 4-8 plausible items if none were provided.
- For testimonials, do NOT invent fake reviews. Skip the section if no testimonials were provided.
- Include real SVG icons (not emoji) for visual elements.

### Nav Structure
The nav must be consistent across all pages:
\`\`\`html
<nav class="nav">
  <div class="nav__inner">
    <a href="index.html" class="nav__brand">{Business Name}</a>
    <div class="nav__links">
      <a href="index.html" class="nav__link">Home</a>
      <!-- other page links -->
      <a href="contact.html" class="nav__link nav__link--cta">Contact</a>
    </div>
    <button type="button" class="nav__toggle" aria-label="Menu" aria-expanded="false">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
    </button>
  </div>
</nav>
\`\`\`

### Footer Structure
\`\`\`html
<footer class="footer">
  <div class="container">
    <div class="footer__brand">{Business Name}</div>
    <div class="footer__tagline">{Short tagline}</div>
    <div class="footer__links">
      <!-- page links -->
    </div>
    <div class="footer__bottom">
      <span>&copy; ${new Date().getFullYear()} {Business Name}. All rights reserved.</span>
      <span class="footer__badge">Built with <a href="https://eonriskservices.com/buildmysite" target="_blank">BuildMySite</a></span>
    </div>
  </div>
</footer>
\`\`\`

### Contact Form
contact.html must include a working form that submits to /api/contact:
\`\`\`html
<form id="contact-form" action="/api/contact" method="POST">
  <!-- name, email, phone (optional), message fields using form-group + form-control classes -->
  <button type="submit" class="btn btn-primary btn-lg btn-block">Send Message</button>
</form>
\`\`\`
Include the JavaScript that handles the form submission via fetch (prevent default, show success/error).

### Step 5: Summary
After building all pages, tell the user what you created: list of pages, the colour scheme you chose, and any suggestions for improvement (photos, logo, additional pages).`;

  const modifyModeSection = `
## Modify Mode — Editing an Existing Site

The user is requesting changes to an existing site via the admin panel.

1. Read the files they're asking about BEFORE making changes
2. Make targeted edits — do not rewrite entire pages unless necessary
3. Maintain consistency: if you change the nav on one page, change it on ALL pages
4. If adding a new page, read an existing page first to match the style
5. Respect the existing colour scheme unless asked to change it

## Page Templates (IMPORTANT)

This site includes pre-built HTML templates with correct CSS structure for these page types:
- gallery.html — image grid using gallery-grid, gallery-item, gallery-item__caption classes
- menu.html — categorised items using menu-category, menu-item, menu-item__name, menu-item__price classes
- testimonials.html — quote cards using testimonial-card, testimonial-card__quote, testimonial-card__author classes
- faq.html — accordion using faq-item, faq-item__question, faq-item__answer with <details>/<summary>

When asked to add, activate, or customise one of these page types:
1. ALWAYS read the existing template file first — do NOT generate the page from scratch
2. Read index.html to match the business name, nav links, and footer
3. Rewrite ONLY the text content (business name, descriptions, items, captions)
4. Keep every CSS class, SVG icon, and HTML structure exactly as-is
5. Update the nav on ALL other .html pages to include a link to the new page
6. These structural CSS classes are validated before commit — if they are missing, the write will be rejected`;

  return `You are BuildMySite, an AI website builder created by EON Risk Services.

Your job is to build and modify professional, responsive websites using plain HTML, CSS, and JavaScript.

## Rules
- Every page must be a complete, valid HTML document
- Use the design system in css/style.css — reference CSS variables (--color-primary, --color-accent, etc.), never hardcode colours
- Every page links to css/style.css and js/main.js
- Write clean, semantic HTML. Use proper headings hierarchy (h1-h6)
- All pages must be fully responsive (mobile-first)
- Include a consistent nav and footer across all pages
- The footer must include: Built with <a href="https://eonriskservices.com/buildmysite">BuildMySite</a>
- Use SVG icons inline (no external icon libraries)
- Do NOT use any frameworks, build tools, or external dependencies
- Write one file at a time using write_file. Always provide the COMPLETE file content.
- If logo_url or hero_url were provided, use them in the appropriate places (logo in nav, hero image as background or inline). Do NOT generate placeholder images or broken image links. Only use image URLs that were explicitly provided.

## Design Principles
- Professional, clean, modern design
- Generous whitespace and clear visual hierarchy
- Readable typography (16px+ body text, 1.7 line height)
- Accessible: proper contrast, alt text, aria labels, focus states
- Fast: no heavy images, no unnecessary JavaScript

## Business Information
${businessBlock || '(No business information provided)'}
${isBuild ? buildModeSection : modifyModeSection}

## Protected Files (do not modify)
- api/agent.js
- api/contact.js
- admin.html
- vercel.json
- package.json`;
}

// ---- Initial build prompt -----------------------------------

function buildInitialPrompt(businessInfo) {
  const info = businessInfo || {};
  const parts = [`Build a complete website for this business:`];

  if (info.name)        parts.push(`Business name: ${info.name}`);
  if (info.description) parts.push(`Description: ${info.description}`);
  if (info.type)        parts.push(`Business type: ${info.type}`);
  if (info.email)       parts.push(`Email: ${info.email}`);
  if (info.phone)       parts.push(`Phone: ${info.phone}`);
  if (info.address)     parts.push(`Address: ${info.address}`);
  if (info.hours)       parts.push(`Opening hours: ${info.hours}`);
  if (info.services)    parts.push(`Services/Products: ${info.services}`);
  if (info.tagline)     parts.push(`Tagline: ${info.tagline}`);
  if (info.tone)        parts.push(`Brand tone: ${info.tone}`);
  if (info.logo_url)    parts.push(`Logo image URL: ${info.logo_url}`);
  if (info.hero_url)    parts.push(`Hero/banner image URL: ${info.hero_url}`);
  if (info.extra)       parts.push(`Additional info: ${info.extra}`);

  parts.push('');
  parts.push('Start by reading the design system (css/style.css), then customise the colours for this business, then build all pages. Go.');

  return parts.join('\n');
}

// ---- Main agent loop ----------------------------------------

async function runAgent(userMessage, env, businessInfo, mode) {
  const model = env.AI_MODEL;
  const apiKey = env.AI_API_KEY;
  const modelConfig = APPROVED_MODELS[model];

  if (!modelConfig) {
    throw new Error(`Model "${model}" is not approved. Approved models: ${Object.keys(APPROVED_MODELS).join(', ')}`);
  }
  if (!apiKey) {
    throw new Error('No AI API key configured');
  }

  const systemPrompt = buildSystemPrompt(businessInfo, mode || 'modify');
  const provider = modelConfig.provider;

  // Internal message history (provider-agnostic)
  const history = [{ role: 'user', content: userMessage }];

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let finalText = '';
  const buildLog = [];
  const pendingWrites = []; // Collected during loop, batch-committed at end

  for (let turn = 0; turn < 25; turn++) {
    let response;

    if (provider === 'anthropic') {
      const msgs = anthropicMessages(history);
      response = await callAnthropic(msgs, systemPrompt, model, apiKey);
    } else if (provider === 'openai') {
      const msgs = openaiMessages(history);
      response = await callOpenAICompatible(msgs, systemPrompt, model, apiKey, 'https://api.openai.com', modelConfig.maxTokens);
    } else if (provider === 'google') {
      const msgs = openaiMessages(history);
      response = await callOpenAICompatible(msgs, systemPrompt, model, apiKey, 'https://generativelanguage.googleapis.com/v1beta/openai', modelConfig.maxTokens);
    }

    totalPromptTokens += response.usage.prompt;
    totalCompletionTokens += response.usage.completion;

    if (response.text) {
      finalText += response.text;
    }

    // No tool calls — agent is done
    if (!response.toolCalls || response.toolCalls.length === 0) {
      break;
    }

    // Record assistant message with tool calls
    history.push({
      role: 'assistant',
      text: response.text,
      tool_calls: response.toolCalls
    });

    // Execute each tool call
    for (const tc of response.toolCalls) {
      let result;
      try {
        result = await executeTool(tc.name, tc.args, env, pendingWrites);
        buildLog.push({ tool: tc.name, args: tc.args, success: true });
      } catch (err) {
        result = { error: err.message };
        buildLog.push({ tool: tc.name, args: tc.args, success: false, error: err.message });
      }

      // Record tool result
      history.push({
        role: 'tool_result',
        tool_use_id: tc.id,
        content: result
      });
    }
  }

  // Batch commit all pending writes in a single commit
  const isBuild = (mode || 'modify') === 'build';
  let commitResult = null;
  if (pendingWrites.length > 0) {
    const gh = makeGitHub(env);
    const commitMsg = isBuild
      ? `BuildMySite: initial site build (${pendingWrites.length} files)`
      : `BuildMySite: update ${pendingWrites.map(f => f.path).join(', ')}`;
    commitResult = await gh.batchCommit(pendingWrites, commitMsg);
  }

  const cost = calcCost(model, totalPromptTokens, totalCompletionTokens);

  return {
    text: finalText,
    buildLog,
    commit: commitResult,
    usage: {
      model,
      provider,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      costUsd: Math.round(cost * 10000) / 10000
    }
  };
}

// ---- Vercel handler -----------------------------------------

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isAgentRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a few minutes.' });
  }

  // Auth check
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken || token !== adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { message, businessInfo, mode } = req.body || {};
  const agentMode = mode === 'build' ? 'build' : 'modify';

  // In build mode, construct the prompt from businessInfo. In modify mode, message is required.
  let userMessage;
  if (agentMode === 'build') {
    if (!businessInfo || !businessInfo.name) {
      return res.status(400).json({ error: 'Business name is required for build mode' });
    }
    userMessage = buildInitialPrompt(businessInfo);
  } else {
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }
    if (typeof message !== 'string' || message.length > 10_000) {
      return res.status(400).json({ error: 'Message must be a string under 10,000 characters' });
    }
    userMessage = message;
  }

  // Build environment from Vercel env vars
  const env = {
    AI_API_KEY: process.env.AI_API_KEY,
    AI_MODEL: process.env.AI_MODEL || 'claude-sonnet-4-6',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_REPO: process.env.GITHUB_REPO,
    GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
  };

  // Validate required env vars
  const missing = [];
  if (!env.AI_API_KEY) missing.push('AI_API_KEY');
  if (!env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  if (!env.GITHUB_REPO) missing.push('GITHUB_REPO');
  if (missing.length > 0) {
    return res.status(500).json({
      error: `Missing environment variables: ${missing.join(', ')}`,
      hint: 'Set these in your Vercel project settings.'
    });
  }

  // Validate model is approved
  if (!APPROVED_MODELS[env.AI_MODEL]) {
    return res.status(400).json({
      error: `Model "${env.AI_MODEL}" is not approved`,
      approved: Object.keys(APPROVED_MODELS)
    });
  }

  try {
    const result = await runAgent(userMessage, env, businessInfo || {}, agentMode);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Agent error:', err);
    return res.status(500).json({
      error: err.message,
      hint: 'Check your API key, GitHub token, and model configuration.'
    });
  }
}
