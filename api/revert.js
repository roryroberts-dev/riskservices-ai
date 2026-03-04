// ============================================================
// BUILDMYSITE REVERT ENDPOINT
// Deterministic git revert: fetches file content from the parent
// commit and overwrites the current version. No LLM involved.
// ============================================================

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Auth
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken || token !== adminToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { filePath, commitSha } = req.body || {};
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'filePath is required' });
  }
  if (!commitSha || typeof commitSha !== 'string') {
    return res.status(400).json({ error: 'commitSha is required (the commit to revert FROM)' });
  }

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO;
  const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return res.status(500).json({ error: 'Missing GITHUB_TOKEN or GITHUB_REPO env vars' });
  }

  const headers = {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };

  try {
    // 1. Get the parent commit SHA (the state before the bad commit)
    const commitR = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/git/commits/${commitSha}`,
      { headers }
    );
    if (!commitR.ok) throw new Error(`Failed to fetch commit ${commitSha}: ${commitR.status}`);
    const commitData = await commitR.json();

    const parentSha = commitData.parents?.[0]?.sha;
    if (!parentSha) {
      return res.status(400).json({ error: 'No parent commit found — cannot revert the initial commit' });
    }

    // 2. Fetch the file content at the parent commit
    const fileR = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}?ref=${parentSha}`,
      { headers }
    );

    if (fileR.status === 404) {
      // File didn't exist before this commit — revert means delete it
      const currentR = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`,
        { headers }
      );
      if (!currentR.ok) {
        return res.status(404).json({ error: `File ${filePath} not found on current branch either` });
      }
      const currentData = await currentR.json();
      const delR = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
        {
          method: 'DELETE',
          headers,
          body: JSON.stringify({
            message: `Revert: remove ${filePath} (did not exist before ${commitSha.slice(0, 7)})`,
            sha: currentData.sha,
            branch: GITHUB_BRANCH
          })
        }
      );
      if (!delR.ok) throw new Error(`Failed to delete ${filePath}: ${delR.status}`);
      return res.status(200).json({ reverted: filePath, action: 'deleted', parentSha });
    }

    if (!fileR.ok) throw new Error(`Failed to fetch ${filePath} at parent ${parentSha}: ${fileR.status}`);
    const fileData = await fileR.json();
    const oldContent = fileData.content; // Already base64 from GitHub

    // 3. Get the current file SHA (needed for the PUT)
    const currentR = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`,
      { headers }
    );
    if (!currentR.ok) throw new Error(`Failed to fetch current ${filePath}: ${currentR.status}`);
    const currentData = await currentR.json();

    // 4. Overwrite with the parent version
    const putR = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `Revert ${filePath} to pre-${commitSha.slice(0, 7)} state`,
          content: oldContent,
          sha: currentData.sha,
          branch: GITHUB_BRANCH
        })
      }
    );
    if (!putR.ok) {
      const t = await putR.text();
      throw new Error(`Failed to write reverted ${filePath}: ${putR.status} ${t}`);
    }

    return res.status(200).json({ reverted: filePath, action: 'restored', parentSha });
  } catch (err) {
    console.error('Revert error:', err);
    return res.status(500).json({ error: err.message });
  }
}
