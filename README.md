# BuildMySite

A self-building website powered by AI. Tell it about your business, it builds your entire site.

**Free. Open source. You own everything.**

## What is this?

BuildMySite is a website kit that builds itself. You provide your business details and an AI API key, and the AI agent writes a complete, professional website — deployed live on Vercel, code in your GitHub.

- Plain HTML, CSS, and JavaScript — no frameworks, no build step
- Responsive, accessible, mobile-first design
- Working contact form with email delivery
- Admin panel for ongoing changes ("What would you like to change?")
- Multi-provider AI: Claude, GPT, or Gemini

## Quick Start

The easiest way is to use the wizard at [eonriskservices.com/buildmysite](https://eonriskservices.com/buildmysite).

### Manual Setup

1. Fork this repo to your GitHub account
2. Create a [Vercel](https://vercel.com) project linked to your fork
3. Set these environment variables in Vercel:

| Variable | Required | Description |
|----------|----------|-------------|
| `AI_API_KEY` | Yes | Your API key (Anthropic, OpenAI, or Google) |
| `AI_MODEL` | Yes | One of: `claude-sonnet-4-6`, `claude-opus-4-6`, `gpt-5.2`, `gemini-3.1-pro` |
| `GITHUB_TOKEN` | Yes | GitHub personal access token (Contents: read/write) |
| `GITHUB_REPO` | Yes | Your repo in `owner/repo` format |
| `ADMIN_TOKEN` | Yes | A secret token for the admin panel |
| `CONTACT_EMAIL` | No | Email address for contact form submissions |
| `RESEND_API_KEY` | No | [Resend](https://resend.com) API key for email delivery |

4. Open `your-site.vercel.app/admin.html` and sign in with your admin token
5. Tell the AI what to build

## File Structure

```
├── index.html          # Home page (AI-generated)
├── contact.html        # Contact page with form
├── admin.html          # Admin panel
├── css/
│   └── style.css       # Design system
├── js/
│   └── main.js         # Shared JavaScript
├── api/
│   ├── agent.js        # AI agent (serverless function)
│   └── contact.js      # Contact form handler
├── vercel.json         # Vercel configuration
└── package.json        # Dependencies
```

## How It Works

1. You type a request in the admin panel (e.g., "Add a services page with our plumbing services")
2. The admin panel sends your request to `/api/agent`
3. The AI agent reads your existing files, plans changes, and writes updated files via the GitHub API
4. GitHub commits trigger Vercel auto-deploy
5. Your site is live with the changes in seconds

## Approved Models

Only top-tier models are approved to ensure quality output:

| Model | Provider | Cost (per 1M tokens) |
|-------|----------|---------------------|
| Claude Sonnet 4.6 | Anthropic | $3 in / $15 out |
| Claude Opus 4.6 | Anthropic | $15 in / $75 out |
| GPT 5.2 | OpenAI | $3 in / $15 out |
| Gemini 3.1 Pro | Google | $2 in / $12 out |

## Security

- API keys are stored as Vercel environment variables — never in code
- Admin panel protected by token authentication
- All AI calls happen server-side
- Path traversal protection on file operations
- Protected files (agent.js, admin.html, etc.) cannot be modified by the AI
- Rate limiting on both the agent and contact form endpoints

## Built by

[EON Risk Services](https://eonriskservices.com) — AI solutions for businesses.

Need help? [Let us build it for you](https://eonriskservices.com/contact.html).

## License

MIT License. See [LICENSE](LICENSE).
