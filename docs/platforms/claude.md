# Connecting Claude

Claude (claude.ai on the web, Claude Desktop, the mobile apps) connects to Workspace MCP as a **custom connector**. You need the MCP address of your workspace, `https://<your address>/mcp`, shown on the **Platforms** screen.

Checked against Claude's documentation on 25 November 2026: [custom connectors](https://claude.com/docs/connectors/custom), [authentication for connectors](https://claude.com/docs/connectors/building/authentication) and the help article [Get started with custom connectors](https://support.claude.com/en/articles/11175166). A real connection from Claude is the final check and is done by the owner after deployment.

## How it connects

- **Registration.** Claude prefers a Client ID Metadata Document (its "published identity"), then dynamic client registration, then a client you enter by hand. It uses its published identity only when the authorization server advertises `client_id_metadata_document_supported: true` and the `none` token endpoint auth method. Workspace MCP advertises both, so the default option works without any registration on your side.
- **Callback.** The hosted apps return to `https://claude.ai/api/mcp/auth_callback`.
- **Security.** Claude always sends PKCE with `S256`, which the server requires. It reads the protected resource metadata from the `WWW-Authenticate` header of the `401` that `/mcp` returns, asks for `offline_access` because the server lists it, and renews tokens with the rotating refresh token before they expire.

## Requirements on your deployment

- The address must be reachable from the public internet on port 443. Claude does not accept other ports.
- Claude's servers call from `160.79.104.0/21`. If a firewall, WAF or bot protection sits in front of the service, let that range through to `/mcp`, `/.well-known/…` and `/api/auth/…`.
- Enter the MCP address exactly as `https://<your address>/mcp`: the `resource` in the server's metadata must equal the address you enter.

## Steps (Pro and Max)

1. In Claude, open **Customize → Connectors**, choose **+ Add**, then **Add custom connector**.
2. Enter a name (for example "Workspace") and the MCP address `https://<your address>/mcp`. Choose **Continue**.
3. For authentication, keep the OAuth sign-in. For the OAuth client, keep **Use Claude's published identity**. Leave request headers and advanced transport settings empty. Choose **Add**.
4. Claude opens the consent screen of your workspace. Sign in with your passkey, name the connection (for example "Claude"), and choose **Approve**.
5. In a chat, enable the connector under **+ → Connectors** and say: *"This is my workspace. Call `start` and continue from there."*

On Team and Enterprise plans an Owner adds the connector under **Organization settings → Connectors → Add → Custom → Web**; members then connect it from **Customize → Connectors**. Free plans allow one custom connector.

Authentication settings of a connector cannot be changed after it is added. To switch the OAuth client option, remove the connector and add it again.

## If the default option fails

- **Register automatically** uses dynamic client registration. The server accepts it with the Claude callback above.
- **Use your own OAuth client**: on **Platforms → Create a client** in the web interface, create a client with the redirect URI `https://claude.ai/api/mcp/auth_callback`. Untick **The platform keeps a client secret** for a public client, or keep it ticked and enter the secret in Claude. Enter the client ID (and the secret, if you created one) in Claude.

Every attempt is recorded under **Platforms → Diagnostics** in the web interface: discovery, registration, authorization, token exchange and refresh, with the error from the server.

## Claude Code

Claude Code connects as an MCP client from your own computer and uses a loopback redirect on a random port. The server accepts loopback redirects on any port for native clients, as RFC 8252 asks. A client that registers only loopback or custom-scheme redirects and sends no `application_type` is treated as a native app, as the MCP authorization profile says clients should declare; one that explicitly says `web` keeps the stricter rules. Add it with `claude mcp add --transport http workspace https://<your address>/mcp` and complete the sign-in in the browser it opens. This path has not been tested against a real Claude Code session.
