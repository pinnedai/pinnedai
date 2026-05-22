import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ForNextjs } from "./seo/ForNextjs.js";
import { ForClaudeCode } from "./seo/ForClaudeCode.js";
import { ForCursor } from "./seo/ForCursor.js";
import "./styles.css";

// Lightweight pathname-based routing. v0.1 trades full SSR/SSG for
// shipping speed — Vercel rewrites all /for-* paths to index.html and
// React picks the right page client-side. For better SEO we'll move to
// Vite's multi-page setup or Astro in v0.2.
function route() {
  const path = window.location.pathname.replace(/\/+$/, "");
  switch (path) {
    case "/for-nextjs":
      return <ForNextjs />;
    case "/for-claude-code":
      return <ForClaudeCode />;
    case "/for-cursor":
      return <ForCursor />;
    default:
      return <App />;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{route()}</StrictMode>
);
