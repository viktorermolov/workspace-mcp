# Connecting Grok

Grok (grok.com) connects to remote MCP servers as **custom connectors**. You need the MCP address of your workspace, `https://<your address>/mcp`, shown on the **Platforms** screen.

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
3. Several Grok Bots can share that one connection. On the **Platforms** screen, review the suggested list of roles for that connection (taken from its own history) and confirm the ones the platform may use. If enforcement is already on, a new connection cannot write until you confirm its list.
4. Add each bot as an agent under the connection (**Add an agent**): a name, a short name, and the roles it may take, chosen from the list you confirmed. Each bot passes its role as `claimed_role` and its short name as `agent` in `start` and on every write, so the log shows which bot acted and a task can be addressed to one bot with `for_agent`. Put both into the bot's standing instruction: see [agent-instruction.md](../agent-instruction.md).
5. In a chat with the connector enabled, say: *"This is my workspace. Call `start` and continue from there."*

## Reconnecting

The existing connection stays in use until Grok completes the authorization-code exchange. Approving the consent screen alone does not drop the previous tokens. If you approve more than once before the exchange finishes, only one switch happens, and only after a successful exchange.

**If you reconnect from Safari on iPhone** (or another iOS browser) and the Grok app is installed, iOS may open the app and leave the consent page on screen. The documented callback, `https://grok.com/connectors-oauth-exchange-code/`, is claimed as a universal link by the Grok app (its [apple-app-site-association](https://grok.com/.well-known/apple-app-site-association) file matches all paths except an explicit exclude list, and this callback is not excluded). That hand-off is decided by iOS, not by this server.

Do not press **Approve** again. If access does not complete, try opening the callback in Safari so the page on grok.com can finish the exchange:

1. If the consent page still shows a **Continue to the platform** link, long-press it.
2. Choose to open the link in Safari (not in the Grok app).

Apple documents this long-press choice in [TN3155](https://developer.apple.com/documentation/technotes/tn3155-debugging-universal-links): on iOS, long-pressing a universal link offers the app and the browser, and the option you pick becomes the default for that domain. **These reconnect steps have not been tested on a real iPhone**; they follow Apple's documented control, not a trial of this flow.

If the Grok app itself offers a way to add or reconnect the connector, starting from the app may also work, because the app then holds the authorization request. That path is likewise untested here.

## If it fails

Open **Platforms → Diagnostics** in the web interface. Every step of the attempt is recorded: discovery, registration, authorization, token exchange.

- **Nothing recorded at all**: Grok did not reach the server. Check that the address is public and that no login wall (Cloudflare Access) or bot challenge sits in front of it.
- **Registration failed**: the diagnostics show the redirect URI Grok sent and the reason. Create a manual client with that URI (below).
- **Grok asks for a client ID and secret**: create a manual client with the redirect URI `https://grok.com/connectors-oauth-exchange-code/` (or the one Grok shows), and enter the ID and secret in Grok.

To create a manual client: **Platforms → Create a client**, enter a name and the redirect URI, and keep **The platform keeps a client secret** ticked if Grok asks for a secret. The secret is shown once.

## Grok Bot routines

To wake a Grok Bot routine when a task is assigned to its role, use a webhook: see the example in [webhooks.md](../webhooks.md#example-receiver-a-grok-bot-routine).
