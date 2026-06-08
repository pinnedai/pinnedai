// README badge endpoint — `GET /badge/:owner/:repo.svg`.
//
// Fetches the customer's PINS.md from raw.githubusercontent.com,
// counts active pins, returns a shields-style SVG. Every public repo
// using pinnedai becomes a free billboard on their README.
//
// Public repos only — private repos require a token (deferred).
// Cached 1 hour at the edge.

type CountResult = { count: number; cached: boolean };

const CACHE_TTL_SECONDS = 3600;

// GitHub usernames: 1-39 chars, alphanumeric + hyphens, no leading/
// trailing hyphen. Matches GitHub's own username validation.
const GITHUB_USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
// GitHub repo names: alphanumeric + dot/hyphen/underscore. More
// permissive than usernames (repos can have dots and underscores).
const GITHUB_REPO_RE = /^[a-zA-Z0-9._-]{1,100}$/;

export async function handleBadge(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/badge\/([^/]+)\/([^/]+?)(\.svg|\.json)?$/.exec(
    url.pathname
  );
  if (!match) {
    return new Response("not found", { status: 404 });
  }
  const [, ownerRaw, repoRaw, ext] = match;
  // Validate against GitHub's own naming rules BEFORE interpolation.
  // Rejects URL-encoded path-traversal attempts (%2e%2e) and any
  // characters that aren't legal in a real GitHub owner/repo. The
  // route regex above only blocks literal `/`; this is the second-
  // line defense before we hand the strings to fetch().
  if (!GITHUB_USERNAME_RE.test(ownerRaw) || !GITHUB_REPO_RE.test(repoRaw)) {
    return new Response("not found", { status: 404 });
  }
  // No trailing dots or double dots in repo names (defense in depth —
  // the regex above already blocks `..` since it requires the whole
  // string to match, but be explicit).
  if (repoRaw === "." || repoRaw === ".." || repoRaw.includes("..")) {
    return new Response("not found", { status: 404 });
  }
  const owner = ownerRaw;
  const repo = repoRaw;
  const wantJson = ext === ".json";

  let result: CountResult;
  try {
    result = await fetchPinCount(owner, repo);
  } catch {
    result = { count: 0, cached: false };
  }

  if (wantJson) {
    return new Response(
      JSON.stringify({ owner, repo, activePins: result.count }, null, 2),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
        },
      }
    );
  }

  return new Response(renderSVG(result.count), {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
    },
  });
}

async function fetchPinCount(
  owner: string,
  repo: string
): Promise<CountResult> {
  for (const branch of ["main", "master"]) {
    // URL-encode each path segment. The caller validates owner/repo
    // against GitHub naming rules so encoding is conservative — but
    // any leftover special chars (legal but unusual) get safely
    // percent-encoded here rather than breaking the URL or letting
    // the request body change shape.
    const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/tests/pinned/PINS.md`;
    try {
      const res = await fetch(rawUrl, {
        cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
      } as RequestInit);
      if (res.ok) {
        const body = await res.text();
        return { count: countActivePins(body), cached: false };
      }
    } catch {
      // try next branch
    }
  }
  return { count: 0, cached: false };
}

function countActivePins(pinsMd: string): number {
  // Find the "## Active" section and count table rows below it,
  // stopping at the next "##" heading.
  const lines = pinsMd.split("\n");
  let inActive = false;
  let count = 0;
  for (const line of lines) {
    if (/^##\s+Active\b/i.test(line)) {
      inActive = true;
      continue;
    }
    if (inActive && /^##\s/.test(line)) break;
    if (!inActive) continue;
    // Table data row: starts with `|`, not a separator like `|---|---|`
    if (line.startsWith("|") && !line.includes("---") && !/^\|\s*Claim\s*\|/i.test(line)) {
      count++;
    }
  }
  return count;
}

// Shields.io-style SVG — left side is "pinned", right side is the count.
function renderSVG(count: number): string {
  const label = "pinned";
  const value = count === 0 ? "—" : `${count} active`;
  const labelWidth = 50;
  const valueWidth = Math.max(60, 14 + value.length * 7);
  const totalWidth = labelWidth + valueWidth;
  const bgRight = count === 0 ? "#9f9f9f" : "#ffb454";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${value}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#0b0d10"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${bgRight}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" fill="#0b0d10">${value}</text>
  </g>
</svg>`;
}
