// Fixture for testing the Worker's OIDC validation end-to-end.
//
// Generates an RSA-2048 keypair, builds a JWKS document that exposes
// the public key, runs a tiny HTTP server serving that JWKS, and signs
// GitHub-OIDC-shaped tokens with the private key.
//
// The Worker's validateGithubOidc fetches GITHUB_JWKS_URL — we point
// it at our local server. Result: full signature validation, full
// audience/issuer/exp/nbf checks, against a real signed token. No
// miniflare needed — we call worker.fetch() directly.

import { createServer, type Server } from "node:http";
import {
  generateKeyPairSync,
  createSign,
  type KeyObject,
} from "node:crypto";

export type OidcFixture = {
  jwksUrl: string;
  stop: () => Promise<void>;
  signToken(claims: Record<string, unknown>): string;
};

export type SignableClaims = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  repository?: string;
  repository_owner?: string;
  repository_id?: string;
  repository_visibility?: "public" | "private" | "internal";
  workflow?: string;
  ref?: string;
  sha?: string;
  actor?: string;
  event_name?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
};

export async function startOidcFixture(): Promise<OidcFixture> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const kid = "audit-key-1";

  // Build the JWKS document (n + e from the public key).
  const jwk = publicKeyToJwk(publicKey, kid);
  const jwks = JSON.stringify({ keys: [jwk] });

  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith("/jwks")) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(jwks);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to bind"));
        return;
      }
      resolve(addr.port);
    });
  });
  const jwksUrl = `http://127.0.0.1:${port}/jwks`;

  return {
    jwksUrl,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    signToken(claims) {
      return signRS256(privateKey, kid, claims);
    },
  };
}

function publicKeyToJwk(publicKeyPem: string, kid: string) {
  // Convert PEM → JWK (n, e) using crypto.createPublicKey().export({format:'jwk'})
  // which Node 16+ supports.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPublicKey } = require("node:crypto");
  const ko: KeyObject = createPublicKey(publicKeyPem);
  const jwk = ko.export({ format: "jwk" }) as {
    kty: string;
    n: string;
    e: string;
  };
  return {
    kty: jwk.kty,
    alg: "RS256",
    use: "sig",
    kid,
    n: jwk.n,
    e: jwk.e,
  };
}

function signRS256(
  privateKeyPem: string,
  kid: string,
  claims: Record<string, unknown>
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    iss: "https://token.actions.githubusercontent.com",
    aud: "pinnedai",
    sub: "repo:acme/repo:pull_request",
    repository: "acme/repo",
    repository_owner: "acme",
    repository_id: "12345",
    repository_visibility: "public",
    workflow: "pinned",
    ref: "refs/pull/1/merge",
    sha: "deadbeef",
    actor: "alice",
    event_name: "pull_request",
    iat: now,
    exp: now + 600,
    nbf: now - 10,
    ...claims,
  };
  const b64h = base64UrlEncode(JSON.stringify(header));
  const b64p = base64UrlEncode(JSON.stringify(payload));
  const signing = `${b64h}.${b64p}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signing);
  const sig = signer.sign(privateKeyPem);
  return `${signing}.${base64UrlEncodeBuffer(sig)}`;
}

function base64UrlEncode(s: string): string {
  return base64UrlEncodeBuffer(Buffer.from(s, "utf8"));
}
function base64UrlEncodeBuffer(b: Buffer): string {
  return b
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
