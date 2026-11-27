# Connecting any other platform

There is a page for [Claude](claude.md), [ChatGPT](chatgpt.md) and [Grok](grok.md). Any other platform or agent that speaks MCP over Streamable HTTP with OAuth connects the same way. This page says what such a client needs, without steps for a particular product: those change, and none has been checked here.

## What the client needs

- **The MCP address** of your workspace, `https://<your address>/mcp`, shown on the **Connections** screen. The client discovers everything else from it.
- **Streamable HTTP.** The server is stateless and does not offer the older SSE transport.
- **OAuth 2.1 with PKCE (`S256`).** A client registers in one of three ways: a Client ID Metadata Document, dynamic client registration, or a client you create by hand.
- **A browser step.** Every connection is approved by you on the consent screen with your passkey. A client that cannot open a sign-in page (a headless agent on a server, for example) cannot connect with a static token: the server has none.

## Steps

1. Add the MCP address in the platform as a custom or remote MCP server.
2. When it opens the consent screen of your workspace, sign in with your passkey, name the connection after the platform, and choose **Approve**.
3. If the platform asks for a client ID and secret instead: **Connections → Create a client**, enter a name and the redirect URI the platform shows, and paste the ID and secret into the platform. The secret is shown once.
4. On **Connections**, confirm the roles the platform may act as. If several named bots share it, add each as an agent under the platform (next section).
5. Give the agent the standing instruction from [agent-instruction.md](../agent-instruction.md).

## Several agents on one platform

One connection is one platform. When several named bots work through it, add each of them under the platform on **Connections** (**Add an agent**) with a short name and the roles it may take, chosen from the roles confirmed for the platform. Each bot then passes its short name as `agent` in `start` and on every write, so the log, checkpoints and task claims show which of them acted, and a task can be addressed to one of them with `for_agent`.

The server can verify only the platform, not which bot is calling. The agent's name guards against mix-ups between your own bots, not against a hostile one.

## If it fails

Open **Connections → Diagnostics**. Every step of an attempt is recorded there without secrets: discovery, registration, authorization, token exchange. Nothing recorded means the client never reached the server: check that the address is public and that no login wall or bot challenge sits in front of it.
