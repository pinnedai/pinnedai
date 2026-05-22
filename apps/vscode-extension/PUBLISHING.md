# Publishing the pinnedai VS Code extension

The extension ships to two registries. Most VS Code-family editors search one or the other:

| Registry | Reaches | Auth |
|---|---|---|
| **OpenVSX** (`open-vsx.org`) | Cursor, VSCodium, Gitpod, Theia, Coder | Eclipse Foundation account |
| **VS Code Marketplace** (`marketplace.visualstudio.com`) | VS Code (Microsoft default install) | Microsoft + Azure DevOps account |

Publishing to both is recommended for v0.1. Order on launch day: **OpenVSX first** (less setup friction, captures Cursor users), then VS Code Marketplace.

---

## One-time setup (~25 min total, only needed once per machine)

### 1. OpenVSX (~10 min)

1. Sign in at https://open-vsx.org with GitHub
2. Agree to the Eclipse Foundation publisher agreement (one click)
3. Visit https://open-vsx.org/user-settings/tokens → "Generate New Token"
4. Copy the token. Save it as `OVSX_PAT` in your shell or password manager:
   ```bash
   export OVSX_PAT='your-token-here'
   ```
5. Claim the `pinnedai` namespace: https://open-vsx.org/user-settings/namespaces → "Create namespace" → enter `pinnedai`

### 2. VS Code Marketplace (~15 min)

1. Sign up for an Azure DevOps Organization (free): https://dev.azure.com → "New organization"
2. Create a Personal Access Token:
   - Top right → User settings → Personal access tokens → New Token
   - **Organization**: All accessible organizations
   - **Scopes**: Custom defined → check "Marketplace" → "Manage"
   - Expiration: max (1 year)
3. Copy the token. Save it:
   ```bash
   export VSCE_PAT='your-token-here'
   ```
4. Create publisher on Marketplace: https://marketplace.visualstudio.com/manage → "Create publisher" → Publisher ID `pinnedai`
5. Verify the publisher ID in `package.json` matches (`"publisher": "pinnedai"`)

---

## Publishing a release

Make sure the extension's `version` in `package.json` is bumped from any prior published version, then:

```bash
cd apps/vscode-extension
pnpm install      # picks up ovsx if newly added
pnpm run build    # produces dist/extension.js

# Day 0: ship to OpenVSX (Cursor + family)
pnpm run publish:ovsx

# Day 1+: ship to VS Code Marketplace (after 24h soak with Cursor users)
pnpm run publish:vsce
```

Or to publish to both at once (only after both setups are done):

```bash
pnpm run publish:all
```

Both commands use the `.vsix` produced by `vsce`/`ovsx` from the current source tree. No need to run `pnpm run package` separately — publish commands rebuild from source.

---

## Verifying after publish

- **OpenVSX**: https://open-vsx.org/extension/pinnedai/pinnedai-vscode should resolve within 30 seconds
- **VS Code Marketplace**: https://marketplace.visualstudio.com/items?itemName=pinnedai.pinnedai-vscode should resolve within ~5 min (Microsoft sometimes runs a brief async scan)

In Cursor: open Extensions panel (Cmd+Shift+X) → search "pinnedai" → should appear.
In VS Code: same.

---

## If publishing fails

- **`401 Unauthorized`**: Token expired or wrong scope. Regenerate per the setup steps above.
- **`Missing publisher name`**: Make sure `package.json` has `"publisher": "pinnedai"`.
- **`A version X.Y.Z already exists`**: Bump `package.json` version, rebuild, retry.
- **VS Code Marketplace "Manage" scope rejected**: Make sure the PAT was created with the *Marketplace > Manage* scope specifically, not just *Read*.
