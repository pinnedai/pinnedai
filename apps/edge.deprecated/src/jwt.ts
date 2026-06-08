// GitHub Actions OIDC JWT validation.
//
// GitHub Actions issues a short-lived (5 min) signed JWT to any
// workflow that declares `permissions: id-token: write`. We validate
// it against GitHub's published JWKS (rotated periodically) and
// trust the `repository` claim as the cryptographic identity of the
// caller. No customer API key required — that's the wedge.
//
// Spec: https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect

export type GithubOidcClaims = {
  iss: string;
  aud: string;
  sub: string;
  repository: string;          // e.g. "acme/api"
  repository_owner: string;    // e.g. "acme"
  repository_id: string;
  // "public" | "private" | "internal". Public repos get unlimited
  // LLM calls on Free tier; private gets the abuse cap. Always
  // present on GitHub OIDC tokens.
  repository_visibility?: "public" | "private" | "internal";
  workflow: string;
  ref: string;
  sha: string;
  actor: string;
  event_name: string;
  iat: number;
  exp: number;
  nbf?: number;
};

type Jwk = {
  kid: string;
  kty: string;
  alg: string;
  use: string;
  n: string;
  e: string;
};

type JwksCache = {
  fetchedAt: number;
  keys: Map<string, CryptoKey>;
};

let jwksCache: JwksCache | null = null;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — GitHub rotates infrequently

export async function validateGithubOidc(
  token: string,
  opts: { jwksUrl: string; expectedAudience: string }
): Promise<GithubOidcClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("oidc: malformed token");

  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(b64urlToString(headerB64)) as {
    alg: string;
    kid: string;
    typ?: string;
  };
  if (header.alg !== "RS256") {
    throw new Error(`oidc: unsupported alg ${header.alg}`);
  }

  const keys = await getJwks(opts.jwksUrl);
  const key = keys.get(header.kid);
  if (!key) {
    // KID rotated since last cache — refresh once and retry
    jwksCache = null;
    const fresh = await getJwks(opts.jwksUrl);
    const retry = fresh.get(header.kid);
    if (!retry) throw new Error(`oidc: unknown kid ${header.kid}`);
    await verifySig(retry, headerB64, payloadB64, sigB64);
  } else {
    await verifySig(key, headerB64, payloadB64, sigB64);
  }

  const claims = JSON.parse(b64urlToString(payloadB64)) as GithubOidcClaims;

  const now = Math.floor(Date.now() / 1000);
  // Strict: reject tokens at-or-past exp. JWT spec treats exp as
  // exclusive — "MUST NOT be processed on or after the time specified."
  if (claims.exp <= now) throw new Error("oidc: token expired");
  if (claims.nbf && claims.nbf > now) throw new Error("oidc: token not yet valid");
  if (claims.iss !== "https://token.actions.githubusercontent.com") {
    throw new Error(`oidc: unexpected issuer ${claims.iss}`);
  }
  if (claims.aud !== opts.expectedAudience) {
    throw new Error(`oidc: unexpected audience ${claims.aud}`);
  }
  if (!claims.repository || typeof claims.repository !== "string") {
    throw new Error("oidc: missing repository claim");
  }

  return claims;
}

async function getJwks(url: string): Promise<Map<string, CryptoKey>> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`jwks: fetch failed ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  const map = new Map<string, CryptoKey>();
  for (const k of body.keys) {
    if (k.kty !== "RSA" || k.alg !== "RS256") continue;
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: k.kty, n: k.n, e: k.e, alg: "RS256", ext: true } as JsonWebKey,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    map.set(k.kid, cryptoKey);
  }
  jwksCache = { fetchedAt: Date.now(), keys: map };
  return map;
}

async function verifySig(
  key: CryptoKey,
  headerB64: string,
  payloadB64: string,
  sigB64: string
): Promise<void> {
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = b64urlToBytes(sigB64);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sig,
    data
  );
  if (!ok) throw new Error("oidc: bad signature");
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
