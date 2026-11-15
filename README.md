# Picnic MCP server

A hosted MCP server for the [Picnic](https://picnic.app) online supermarket. People add one URL to Claude, ChatGPT, Cursor or any other MCP app, sign in with their Picnic account, and can then ask their assistant to search products, fill the cart, plan recipes and pick a delivery slot.

Built on [picnic-api](https://github.com/MRVDH/picnic-api). Unofficial: not affiliated with, or endorsed by, Picnic.

## For users

Open the server's home page (`https://your-domain/`). It shows the URL to paste and the steps for each app, in English, Dutch, German and French. In short:

| App | How |
| --- | --- |
| Claude (web, desktop, mobile) | Settings → Connectors → Add custom connector → paste `https://your-domain/mcp` |
| Claude Code | `claude mcp add --transport http picnic https://your-domain/mcp`, then `/mcp` |
| ChatGPT | Settings → Apps & Connectors → Developer mode → Create → paste the URL, OAuth |
| Cursor, VS Code | One-click button on the home page, or the JSON snippet shown there |
| Apps with local servers only | `npx -y mcp-remote https://your-domain/mcp` |

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

## Albert Heijn (optional)

With `AH_ENABLED=true` the same server offers a second connector, for [Albert Heijn](https://www.ah.nl) (Netherlands), at `https://your-domain/ah/mcp`. Users add it as a connector of its own, next to Picnic. Unofficial as well: not affiliated with, or endorsed by, Albert Heijn.

| Area | Tools |
| --- | --- |
| Products | `search_products`, `get_product`, `get_promotions` (weekly bonus, personal bonus, the products of one deal) |
| Recipes | `search_recipes`, `get_recipe` (Allerhande, with the product for each ingredient) |
| Basket | `get_cart`, `add_to_cart`, `remove_from_cart`, `clear_cart` |
| Delivery and orders | `get_delivery_slots` (shows the times and their costs), `list_orders` |
| Account | `get_account`, `disconnect_account` |

**Signing in** works differently from Picnic. Albert Heijn only signs people in on its own page, which refuses automated browsers and ends at an address meant for its app (`appie://login-exit?code=…`). So the sign-in page of this server sends the user to Albert Heijn's page in a new tab and asks them to paste the address it ends at. A browser doesn't show that address in its address bar: the user copies it from the developer tools (Network tab), on a computer. The page explains the steps. This server never sees the Albert Heijn password.

A user can also **continue without signing in**. Searching, bonus deals, recipes and delivery times then work; the basket, orders and personal bonus do not.

**No ordering, here too.** At Albert Heijn the shopping list and the online basket are the same thing, and once a delivery or pick-up is booked that basket is a real order. The tools fill the basket while nothing is booked. As soon as a delivery is booked they refuse every change, and they also refuse when they can't check whether one is booked. There is no tool to book a delivery time, to check out or to pay; the user does that in the Albert Heijn app.

What to know before you turn it on:

- It uses the API of Albert Heijn's own app, which is undocumented and changes without notice. `npx tsx scripts/probe-ah.ts` runs the calls that need no account against the live API and prints what comes back; start there when a tool stops working.
- The calls were written from [albertheijn-mcp](https://github.com/danieltyukov/albertheijn-mcp) (MIT) and checked against the live API without an account. Everything that needs an account (signing in with a code, the basket, personal bonus, orders, the check for a booked delivery) is covered by tests against an in-memory stand-in only, so try those with your own account after deploying.
- The second connector lives on a path of the same address. Which connector a sign-in is for follows from the app: it names the MCP address it wants tokens for (`resource`), or asks for the scope `ah`. An app that sends neither gets the Picnic sign-in page.
- **Disconnecting is weaker than for Picnic.** Albert Heijn's app API has no working sign-out, so `disconnect_account` and token revocation end the sign-in on this server: its tokens are refused from then on. That list is kept in memory. After a restart, a token that had leaked would work again until it expires (an access token within a day, a refresh token within the 90 days of its sign-in).

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
| `SIGN_IN_LIMIT_PER_MINUTE` | no | Sign-ins that reach Picnic per minute, for the whole server. Default `60`. The same limit applies to Albert Heijn, counted separately. |
| `AH_ENABLED` | no | `true` adds the Albert Heijn connector at `/ah/mcp`. Default `false`. |
| `AH_SERVICE_NAME` | no | Name on the Albert Heijn sign-in page. Default `Albert Heijn MCP`. |

Run one instance. Sign-ins in progress are held in memory for two minutes, so a second instance behind a load balancer would break some of them.

## How it works

```
AI app ──► POST /mcp  (Bearer token) ──► picnic-api ──► Picnic
   │
   └─ first time: /register → /authorize (sign-in page) → /login → /login/verify → /token
```

- **Transport**: Streamable HTTP at `/mcp`, without sessions. Every request stands on its own.
- **Sign-in**: OAuth 2.1 with PKCE and dynamic client registration, which is what lets a user add the server by URL alone. The sign-in page passes the credentials to Picnic and handles the SMS code.
- **No database**: the server stores nothing. A client registration is sealed into its client id, and the user's Picnic session key is sealed (AES-256-GCM) into the access and refresh token that the AI app holds. A leaked server disk contains no accounts.
- **Passwords** are sent to Picnic once and never stored or logged. Request logs contain the method, path and status only.
- **Signing out**: revoking a token, or the `disconnect_account` tool, signs the session out at Picnic, which invalidates every token of that sign-in. When Picnic can't be reached, revoking fails with an error instead of reporting a token as revoked while it still works.
- **Known apps**: anyone can register an app under any name, so the sign-in page only names an app when it sends the user back to a known address: Claude (`claude.ai`, `claude.com`), ChatGPT (`chatgpt.com`), VS Code (`vscode.dev`, `vscode://`), Cursor (`cursor://`) or an app on the user's own computer (`localhost`). For any other app it shows where the user will be sent and warns them to close the page if someone sent them the link. With `UNKNOWN_APPS=block` such apps are refused; add the ones you want with `EXTRA_KNOWN_APPS`.
- **Limits**: sign-in attempts are limited per IP address (15 per 15 minutes), per Picnic account from any address (10 per 15 minutes), and for the whole server (`SIGN_IN_LIMIT_PER_MINUTE`), so that guessing passwords through this server doesn't get its IP address throttled by Picnic. Only forms that would reach Picnic count toward the last two. Someone who knows a user's email address can keep that account's sign-in blocked here for a while; the user's Picnic account itself is not affected. MCP requests are limited per signed-in user rather than per IP address, because AI apps send all their users' requests from a few addresses.

With `AH_ENABLED=true` there is a second endpoint, `/ah/mcp`, with its own sign-in page (`/ah/login`) on the same OAuth server. Its tokens have their own prefix and encryption keys, so a token of one connector never works on the other. Albert Heijn's own tokens expire and its refresh token changes with every renewal, which a sealed token can't follow by itself; the app's own refresh carries it instead. An access token of this server expires just before the Albert Heijn token inside it, and renewing it renews the Albert Heijn tokens and seals the new pair into the new tokens. Two renewals with the same refresh token (two tabs, or a retry after a lost answer) share one renewal at Albert Heijn. The weekly bonus is the same for everyone, so it is fetched with a visitor token of the server's own and kept for half an hour; nothing fetched with a user's token is shared.

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

`npm run dev` serves `http://localhost:3000` with a throwaway key. The tests run the whole flow (registration, sign-in with SMS code, tokens, MCP calls) against an in-memory stand-in for Picnic, and the same for Albert Heijn against a stand-in for `api.ah.nl` that only knows the calls the server is allowed to make. To try the server by hand, point the MCP Inspector at it:

```bash
npx @modelcontextprotocol/inspector
```
