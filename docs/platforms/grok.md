# Connecting Grok

Grok (grok.com) connects to remote MCP servers as **custom connectors**. You need the MCP address of your workspace, `https://<your address>/mcp`, shown on the **Connections** screen.

## What is known, and from where

Checked on 25 November 2026.

**From xAI's documentation** ([Connectors](https://docs.x.ai/grok/connectors), [tunnelling a custom MCP server](https://docs.x.ai/grok/connectors/custom-mcp-tunneling), [connector management](https://docs.x.ai/grok/connector-management)):

- A custom connector is added by entering the MCP server URL, then completing any required authentication in Grok.
- The server must be reachable from the public internet. Grok refuses `localhost` and private addresses.
- Streamable HTTP works. Cloudflare quick tunnels do not support Server-Sent Events.
- On Business and Enterprise plans an admin adds custom connectors under **+ Add Connector → Other**.
- The documentation does **not** say how Grok registers its OAuth client (metadata document, dynamic registration or a manual client), which callback URL it uses, or whether it uses PKCE.

**From third-party reports** (not confirmed by xAI):

- An open-source MCP server project documents that Grok's custom connectors register by **dynamic client registration** with the callback `https://grok.com/connectors-oauth-exchange-code/`, and that a server which rejected that redirect URI failed at `POST /register` before any sign-in page appeared ([mailindex-mcp pull request 8](https://github.com/alexanderkrauck/mailindex-mcp/pull/8), merged 31 October 2026). The same callback appears in a client metadata document quoted on the Cursor forum.
- A vendor guide also lists dynamic registration for Grok and warns that its callback may differ by surface ([QuickOAuth](https://quickoauth.com/guides/claude-chatgpt-grok-differences/)).

**Conclusion.** Grok is expected to use dynamic client registration with the callback `https://grok.com/connectors-oauth-exchange-code/`. Workspace MCP accepts dynamic registration from any client with an `https` callback, including this one with or without the trailing slash (covered by the test suite). If Grok uses another method or callback on your account, the manual client below covers it. A real connection from Grok is the final check and is done by the owner after deployment.

## Steps

1. In Grok, open **Connectors**, add a custom connector, and enter the MCP address `https://<your address>/mcp`.
2. Grok opens the consent screen of your workspace. Sign in with your passkey, name the connection (for example "Grok"), and choose **Approve**.
3. In a chat with the connector enabled, say: *"This is my workspace. Call `start` and continue from there."*

## If it fails

Open **Connections → Diagnostics** in the web interface. Every step of the attempt is recorded: discovery, registration, authorization, token exchange.

- **Nothing recorded at all**: Grok did not reach the server. Check that the address is public and that no login wall (Cloudflare Access) or bot challenge sits in front of it.
- **Registration failed**: the diagnostics show the redirect URI Grok sent and the reason. Create a manual client with that URI (below).
- **Grok asks for a client ID and secret**: create a manual client with the redirect URI `https://grok.com/connectors-oauth-exchange-code/` (or the one Grok shows), and enter the ID and secret in Grok.

To create a manual client: **Connections → Create a client**, enter a name and the redirect URI, and keep **The platform keeps a client secret** ticked if Grok asks for a secret. The secret is shown once.

## Grok Bot routines

To wake a Grok Bot routine when a task is assigned to its role, use a webhook: see the example in [webhooks.md](../webhooks.md#example-receiver-a-grok-bot-routine).
