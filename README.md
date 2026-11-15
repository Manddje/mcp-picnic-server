# Picnic MCP server

A hosted MCP server for the [Picnic](https://picnic.app) online supermarket. People add one URL to Claude, ChatGPT, Cursor or any other MCP app, sign in with their Picnic account, and can then ask their assistant to search products, fill the cart, plan recipes and pick a delivery slot.

Built on [picnic-api](https://github.com/MRVDH/picnic-api). Unofficial: not affiliated with, or endorsed by, Picnic.

## For users

Open the server's home page (`https://your-domain/`). It shows the URL to paste and the steps for each app, in English, Dutch, German and French. In short:

| App | How |
| --- | --- |
| Claude (web, desktop, mobile) | One-click button on the home page, which opens Claude's “Add custom connector” dialog with the name and address filled in. By hand: Settings → Connectors → Add custom connector → paste `https://your-domain/picnic/mcp` |
| Claude Code | `claude mcp add --transport http picnic https://your-domain/picnic/mcp`, then `/mcp` |
| ChatGPT | Settings → Apps & Connectors → Developer mode → Create → paste the URL, OAuth |
| Cursor, VS Code | One-click button on the home page, or the JSON snippet shown there |

Claude, Cursor and VS Code each have a link that adds a server; the home page turns those into buttons. ChatGPT and Claude Code have no such link, so they stay a few manual steps.
| Apps with local servers only | `npx -y mcp-remote https://your-domain/picnic/mcp` |

The first time, a sign-in page opens: Picnic email address, password, and the code Picnic sends by SMS.

## What the assistant can do

| Area | Tools |
| --- | --- |
| Products | `search_products`, `get_product`, `get_cheaper_alternatives`, `get_favorites`, `get_promotions` |
| Cart | `get_cart`, `add_to_cart`, `remove_from_cart`, `clear_cart` |
| Delivery | `get_delivery_slots`, `select_delivery_slot`, `list_deliveries`, `get_delivery`, `track_delivery` |
| Recipes | `search_recipes`, `list_recipes`, `get_recipe`, `add_recipe_to_cart`, `remove_recipe_from_cart`, `create_recipe`, `delete_recipe` |
| Account | `get_account`, `disconnect_account` |

There is deliberately no tool to check out, pay or cancel an order. The assistant prepares the cart; the user orders in the Picnic app.

## Deploy on Coolify

1. Create a new resource from this Git repository and choose the **Dockerfile** build pack.
2. Set the domain (for example `https://picnic.example.com`) and the exposed port to `3000`. Leave **Ports Mappings** empty, so the app is only reachable through Coolify's proxy.
3. Add one environment variable: `SECRET_KEY`, the output of `openssl rand -hex 32`.
4. Deploy. The health check is built into the image (`/health`).

The image build runs the tests. When one fails the build fails, so Coolify keeps the version that is running.

The public address is taken from the domain Coolify assigns (`COOLIFY_URL`). Set `PUBLIC_URL` yourself when you run it elsewhere.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SECRET_KEY` | yes | Encrypts every token; at least 32 characters. Changing it signs all users out. |
| `PUBLIC_URL` | outside Coolify | The public `https://` origin, without a path. |
| `PORT` | no | Default `3000`. |
| `SERVICE_NAME` | no | Name on the pages. Default `Picnic MCP`. |
| `CONTACT` | no | Email address or URL shown in the footer. |
| `SOURCE_URL` | no | Link to the source code shown in the footer. |
| `TRUST_PROXY` | no | Number of reverse proxies in front. Default `1` on Coolify, otherwise off. Set it to exactly the number of proxies: one too many lets visitors fake their IP address and walk past the sign-in limits. |
| `UNKNOWN_APPS` | no | `warn` (default) or `block`. What to do with an app that isn't a known one; see below. |
| `EXTRA_KNOWN_APPS` | no | Comma separated host names (`app.example.com`) and app schemes (`myapp://`) to treat as known apps. |
| `SIGN_IN_LIMIT_PER_MINUTE` | no | Sign-ins that reach Picnic per minute, for the whole server. Default `60`. |
| `PICNIC_LIMIT_PER_MINUTE` | no | Requests of any kind that reach Picnic per minute, for the whole server. Default `300`. |
| `PICNIC_PAUSE_SECONDS` | no | How long the server sends Picnic nothing after Picnic throttled a request. Default `60`; `0` for no pause. |

Run one instance. Sign-ins in progress are held in memory for two minutes, so a second instance behind a load balancer would break some of them.

## How it works

```
AI app ──► POST /picnic/mcp  (Bearer token) ──► picnic-api ──► Picnic
   │
   └─ first time: /register → /authorize (sign-in page) → /login → /login/verify → /token
```

- **Transport**: Streamable HTTP at `/picnic/mcp`, without sessions. Every request stands on its own. The endpoint used to live at `/mcp`; that address still serves it, so apps that were connected there keep working.
- **Sign-in**: OAuth 2.1 with PKCE and dynamic client registration, which is what lets a user add the server by URL alone. The sign-in page passes the credentials to Picnic and handles the SMS code.
- **No database**: the server stores nothing. A client registration is sealed into its client id, and the user's Picnic session key is sealed (AES-256-GCM) into the access and refresh token that the AI app holds. A leaked server disk contains no accounts.
- **Passwords** are sent to Picnic once and never stored or logged. Request logs contain the method, path and status only.
- **Signing out**: revoking a token, or the `disconnect_account` tool, signs the session out at Picnic, which invalidates every token of that sign-in. When Picnic can't be reached, revoking fails with an error instead of reporting a token as revoked while it still works.
- **Known apps**: anyone can register an app under any name, so the sign-in page only names an app when it sends the user back to a known address: Claude (`claude.ai`, `claude.com`), ChatGPT (`chatgpt.com`), VS Code (`vscode.dev`, `vscode://`), Cursor (`cursor://`) or an app on the user's own computer (`localhost`). For any other app it shows where the user will be sent and warns them to close the page if someone sent them the link. With `UNKNOWN_APPS=block` such apps are refused; add the ones you want with `EXTRA_KNOWN_APPS`.
- **Limits**: sign-in attempts are limited per IP address (15 per 15 minutes), per Picnic account from any address (10 per 15 minutes), and for the whole server (`SIGN_IN_LIMIT_PER_MINUTE`), so that guessing passwords through this server doesn't get its IP address throttled by Picnic. Only forms that would reach Picnic count toward the last two. Someone who knows a user's email address can keep that account's sign-in blocked here for a while; the user's Picnic account itself is not affected. MCP requests are limited per signed-in user rather than per IP address, because AI apps send all their users' requests from a few addresses.
- **Protecting the server's IP address**: every request to Picnic, from any user, passes one guard. It lets through `PICNIC_LIMIT_PER_MINUTE` requests per minute and refuses the rest without sending them. When Picnic answers a request with a throttling response (a 429, or the 403 page of its edge), the guard sends nothing for `PICNIC_PAUSE_SECONDS`, for all users, because requests sent while throttled prolong it. A cart change of many products stops at the first refusal and reports the products it didn't try. The limit is shared, so one very busy user can use it up for the others until the minute is over. Picnic doesn't publish its limits: the defaults are cautious guesses, and the log says when the limit or a pause is reached.

Access tokens last 24 hours. A sign-in lasts 90 days: refresh tokens work until then and refreshing doesn't extend it, so a refresh token that leaks stops working by itself. After 90 days the user signs in again.

## Before you offer this to the public

- It uses Picnic's private app API. Picnic can change or block it at any time, and all users reach Picnic from your server's IP address, so heavy use may be throttled.
- Users type their Picnic password into your site. You are responsible for that trust: serve it over https only, keep `SECRET_KEY` secret, and publish who runs the service (`CONTACT`) and a privacy statement where the law asks for one.

## Development

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

`npm run dev` serves `http://localhost:3000` with a throwaway key. The tests run the whole flow (registration, sign-in with SMS code, tokens, MCP calls) against an in-memory stand-in for Picnic. To try the server by hand, point the MCP Inspector at it:

```bash
npx @modelcontextprotocol/inspector
```
