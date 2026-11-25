# Connecting ChatGPT

ChatGPT connects to remote MCP servers through its connector and plugin platform. You need the MCP address of your workspace, `https://<your address>/mcp`, shown on the **Connections** screen.

Checked against OpenAI's [authentication guide for plugins and apps](https://developers.openai.com/plugins/build/auth) on 25 November 2026. Where in ChatGPT a custom MCP server is added, and which plans and settings allow it, changes often and is not covered by that page; follow OpenAI's current help for adding a custom connector or app. A real connection from ChatGPT is the final check and is done by the owner after deployment.

## How it connects

- **Registration.** ChatGPT prefers a Client ID Metadata Document, falls back to dynamic client registration (it registers once per MCP server connection and reuses the client), and also supports predefined OAuth clients. Workspace MCP supports all three.
- **Callback.** `https://chatgpt.com/connector_platform_oauth_redirect` when the server supports issuer identification (RFC 9207), which Workspace MCP does; otherwise a per-connection `https://chatgpt.com/connector/oauth/<callback id>`. Both are accepted in dynamic registration.
- **Security.** ChatGPT requires PKCE `S256`, sends the `resource` parameter with the MCP address on the authorization and token requests, and requests the OpenID scopes by default. The server issues tokens bound to that resource and lists `openid`, `profile`, `email` and `offline_access` in its metadata.
- **Token endpoint auth.** For metadata-document clients ChatGPT uses `none` or `private_key_jwt`; the server supports both, and `client_secret_post` and `client_secret_basic` for predefined clients.

## Steps

1. In ChatGPT, open the place where custom MCP connectors or apps are added (for example in developer mode), and add a new one with the MCP address `https://<your address>/mcp` and OAuth authentication.
2. ChatGPT opens the consent screen of your workspace. Sign in with your passkey, name the connection (for example "ChatGPT"), and choose **Approve**.
3. In a chat with the connector enabled, say: *"This is my workspace. Call `start` and continue from there."*

ChatGPT reads tool annotations: reads are marked read-only, so it does not ask you to confirm them; writes may ask for confirmation according to your ChatGPT settings.

## If you need a predefined client

If ChatGPT asks for a client ID and secret instead of registering itself:

1. In the web interface, open **Connections → Create a client**.
2. Enter a name and the redirect URI that ChatGPT shows for the connector (`https://chatgpt.com/connector_platform_oauth_redirect` or the `…/connector/oauth/<id>` form). Keep **The platform keeps a client secret** ticked if ChatGPT asks for a secret.
3. Copy the client ID and the secret. The secret is shown once.
4. Enter both in ChatGPT.

## Optional: restrict who can call the server

ChatGPT presents an OpenAI-managed client certificate (mutual TLS) and publishes its egress IP ranges. Workspace MCP does not check either itself: every request still needs a valid token. If you want an extra network-level filter, configure it in your proxy or tunnel. Every attempt is recorded under **Connections → Diagnostics** in the web interface.
