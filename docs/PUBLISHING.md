# Publishing the MCP server (for later)

Nothing here has been published yet. These are the steps for when you're ready. Each one is done by you, with the
project's own accounts. None of it costs money.

**What gets published**

- The **hosted server**: `https://api.blamethestock.com/mcp`. It goes live by itself when the API Worker is
  deployed (see the going-live guide). Nothing extra to publish.
- The **npm package** `blamethestock-mcp`: the `mcp/` folder. It lets people run the tools locally with
  `npx -y blamethestock-mcp`. It just forwards calls to the hosted server.
- **Listings**: the official MCP Registry, Glama, and two "awesome" lists on GitHub.

**Order:** 1. API live, 2. GitHub repo, 3. npm, 4. MCP Registry, 5. Glama, 6. awesome lists.
The listings check that the server actually works, so the API has to be live first.

---

## 1. Check the hosted server works

After the API Worker is deployed and `api.blamethestock.com` is attached:

```sh
npx -y @modelcontextprotocol/inspector --cli https://api.blamethestock.com/mcp --transport http --method tools/list
```

You should see three tools: `blame_split`, `check_copycats`, `launch_report`.

## 2. Make a public GitHub repo for the package

Glama and the awesome lists need a public repo.

1. Sign in to the project GitHub account (not your personal one).
2. Create a new public repo, for example `blamethestock-mcp`.
3. Put **only the contents of the `mcp/` folder** in it, as a fresh repo. Don't push this project's history:
   older commits contain local file paths from this Mac.
   ```sh
   cp -R mcp ~/blamethestock-mcp && cd ~/blamethestock-mcp
   rm -rf node_modules
   git init && git add . && git commit -m "blamethestock-mcp 0.1.0"
   git remote add origin https://github.com/<project-account>/blamethestock-mcp.git
   git push -u origin main
   ```
4. Fill in the repo address in two files, then commit and push again:
   - `package.json`: add `"repository": { "type": "git", "url": "git+https://github.com/<project-account>/blamethestock-mcp.git" }`
   - `server.json`: add `"repository": { "url": "https://github.com/<project-account>/blamethestock-mcp", "source": "github" }`
5. In `glama.json`, replace `REPLACE_WITH_PROJECT_GITHUB_USERNAME` with the project GitHub username.

## 3. Publish to npm

1. Create an npm account at npmjs.com with the project email. Turn on two-factor authentication.
2. In the package folder:
   ```sh
   npm login
   npm publish --access public
   ```
   If npm asks for a one-time code, it's the one from your authenticator app.
3. Check it works:
   ```sh
   npx -y blamethestock-mcp --version
   ```

**Later updates:** raise `version` in **both** `package.json` and `server.json` (same number in both,
for example `0.1.1`), then `npm publish` again.

## 4. Publish to the official MCP Registry

The registry name is `com.blamethestock/blamethestock`. You prove you own blamethestock.com with a DNS record.

1. Install the publisher tool:
   ```sh
   brew install mcp-publisher
   ```
2. Make a signing key (keep `key.pem` private and out of any repo). macOS's built-in openssl can't do this,
   so use Homebrew's:
   ```sh
   brew install openssl
   OPENSSL="$(brew --prefix openssl)/bin/openssl"
   $OPENSSL genpkey -algorithm Ed25519 -out key.pem
   echo "v=MCPv1; k=ed25519; p=$($OPENSSL pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
   ```
   The last command prints a line starting with `v=MCPv1`.
3. Add it as a DNS record in Cloudflare: blamethestock.com → DNS → Add record → type **TXT**,
   name **@** (the root), content = the `v=MCPv1; …` line. Save. Wait a few minutes.
4. Log in and publish, from the package folder:
   ```sh
   mcp-publisher login dns --domain blamethestock.com \
     --private-key "$($OPENSSL pkey -in key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
   mcp-publisher publish
   ```
   The npm package must already be published (step 3); the registry checks that its `mcpName` matches.
5. Check it's listed:
   ```sh
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.blamethestock"
   ```

You can leave the TXT record in place; it's needed again for later updates.

## 5. Glama

1. Go to glama.ai, sign in with the project GitHub account.
2. Add server → paste the GitHub repo address.
3. Glama builds the `Dockerfile` and checks that the tools list loads. `glama.json` tells it who maintains it.
4. Once it shows up, claim it as the maintainer (Glama shows a "Claim" button for repos you own).

## 6. The awesome lists (normal pull requests, from the project GitHub account)

### awesome-mcp-servers

Repo: `github.com/punkpeye/awesome-mcp-servers`

1. Fork it, edit `README.md`, find the **💰 Finance & Fintech** section.
2. Add one line in alphabetical order:
   ```
   - [<project-account>/blamethestock-mcp](https://github.com/<project-account>/blamethestock-mcp) 📇 ☁️ 🏠 - Read-only research on Robinhood Chain coins: how much of a move came from the pair, copycat check, launch report (dev and sniper moves) with proof links. No trading, not advice.
   ```
   (📇 = JavaScript, ☁️ = hosted, 🏠 = runs locally.)
3. Open the pull request. Follow the list's contributing notes; if they ask for a Glama link or badge, add the
   one from step 5.

### awesome-remote-mcp-servers

Repo: `github.com/jaw9c/awesome-remote-mcp-servers`

1. Fork it, edit `README.md`, add a row to the table in alphabetical order:
   ```
   | Blame the Stock | Finance | `https://api.blamethestock.com/mcp` | Open | [Blame the Stock](https://blamethestock.com) |
   ```
   Match the columns the table uses at the time.
2. Open the pull request.

---

## Wording to use everywhere

Short (100 characters max, used in the registry):

> Read-only Robinhood Chain coin research: blame split, copycat check, launch report. Not advice.

Longer:

> Read-only on-chain research for Robinhood Chain coins. Splits a coin's move into "the pair" and "the coin",
> finds look-alike copies of a coin, and shows what a coin's dev and first buyers did, with a Blockscout proof
> link for every number. No trading, no wallet, not financial advice.

Never call a coin a "scam" or "safe" in any listing.

## Install snippets (also in the package README)

- Claude Code (hosted): `claude mcp add --transport http blamethestock https://api.blamethestock.com/mcp`
- Claude Code (local): `claude mcp add blamethestock -- npx -y blamethestock-mcp`
- Claude Desktop (local), in `claude_desktop_config.json`:
  ```json
  { "mcpServers": { "blamethestock": { "command": "npx", "args": ["-y", "blamethestock-mcp"] } } }
  ```
