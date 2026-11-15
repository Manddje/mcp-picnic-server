import type { AhFetch } from "../src/ah/client.js";

type Product = { id: number; title: string; brand: string; size: string; price: number; deal?: string; sponsored?: boolean };

const CATALOG: Product[] = [
  { id: 1001, title: "AH Halfvolle melk", brand: "AH", size: "1 l", price: 1.29 },
  { id: 1002, title: "AH Penne", brand: "AH", size: "500 g", price: 0.99, deal: "2 voor 1.50" },
  { id: 1003, title: "Merk Melk reclame", brand: "Merk", size: "1 l", price: 1.99, sponsored: true },
];

const restProduct = (p: Product) => ({
  webshopId: p.id,
  title: p.title,
  brand: p.brand,
  salesUnitSize: p.size,
  priceBeforeBonus: p.price,
  currentPrice: null,
  isBonus: Boolean(p.deal),
  bonusMechanism: p.deal ?? null,
  bonusEndDate: "2999-12-31",
  mainCategory: "Zuivel",
  isOrderable: true,
  isSponsored: Boolean(p.sponsored),
});

const basketProduct = (p: Product) => ({ id: p.id, title: p.title, salesUnitSize: p.size, priceV2: { now: { amount: p.price }, was: { amount: p.price } } });

const BONUS_START = "2000-01-01";
const BONUS_END = "2999-12-30";

type Token = { member: string | null; expiresAt: number };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * An in-memory stand-in for api.ah.nl, at the level of the requests the server sends. It knows the
 * calls the server is allowed to make and nothing else: any other call lands in `unexpected`.
 */
export class FakeAh {
  /** How long the next tokens are valid, in seconds. */
  expiresIn = 7200;
  /** Albert Heijn can't be reached. */
  down = false;
  /** Albert Heijn blocks this server's IP address. */
  blocked = false;
  /** The check for a booked delivery fails. */
  orderCheckDown = false;
  /** Members with a booked delivery: their basket is an order. */
  readonly booked = new Set<string>();
  readonly calls: string[] = [];
  /** Calls the server should never make: unknown ones, and changes that would land in an order. */
  readonly unexpected: string[] = [];
  refreshes = 0;

  private readonly codes = new Map<string, string>();
  private readonly access = new Map<string, Token>();
  private readonly refresh = new Map<string, string | null>();
  private readonly baskets = new Map<string, Map<number, number>>();
  private count = 0;

  /** A sign-in code for a member, as the address Albert Heijn's sign-in page ends at. A code works once. */
  loginExit(member: string): string {
    const code = `code-${member}-${++this.count}-abcdef`;
    this.codes.set(code, member);
    return `appie://login-exit?code=${code}`;
  }

  /** Makes Albert Heijn forget every access token of a member, as when it ends one before its time. */
  dropAccessTokens(member: string): void {
    for (const [token, entry] of this.access) {
      if (entry.member === member) this.access.delete(token);
    }
  }

  /** Makes Albert Heijn forget every refresh token of a member (null: of visitors), as when it ends a sign-in. */
  dropRefreshTokens(member: string | null): void {
    for (const [token, owner] of this.refresh) {
      if (owner === member) this.refresh.delete(token);
    }
  }

  quantity(member: string, productId: number): number {
    return this.baskets.get(member)?.get(productId) ?? 0;
  }

  private issue(member: string | null) {
    const n = ++this.count;
    const accessToken = `at-${n}`;
    const refreshToken = `rt-${n}`;
    this.access.set(accessToken, { member, expiresAt: Date.now() / 1000 + this.expiresIn });
    this.refresh.set(refreshToken, member);
    return json(200, { access_token: accessToken, refresh_token: refreshToken, expires_in: this.expiresIn });
  }

  private basket(member: string | null) {
    const lines = [...(member ? (this.baskets.get(member) ?? []) : [])].map(([id, quantity]) => ({
      id: `line-${id}`,
      quantity,
      isStrikethrough: false,
      product: basketProduct(CATALOG.find((p) => p.id === id)!),
    }));
    const booked = member !== null && this.booked.has(member);
    return {
      id: `basket-${member ?? "visitor"}`,
      itemsInList: booked ? [] : lines,
      itemsInOrder: booked ? lines : null,
      notes: [{ description: "ballonnen", quantity: 1 }],
      summary: { quantity: lines.length, shoppingType: booked ? "DELIVERY" : null, deliveryDate: booked ? "2030-01-02" : null, price: null },
    };
  }

  private change(member: string | null, items: { id: number; quantity: number }[], add: boolean) {
    if (member === null) {
      this.unexpected.push("basket change for a visitor");
      return { status: "FAILED", errorMessage: "no account", result: null };
    }
    if (this.booked.has(member)) this.unexpected.push("basket change while a delivery is booked");
    const lines = this.baskets.get(member) ?? new Map<number, number>();
    for (const item of items) {
      if (!CATALOG.some((p) => p.id === item.id)) continue;
      const next = add ? (lines.get(item.id) ?? 0) + item.quantity : item.quantity;
      if (next > 0) lines.set(item.id, next);
      else lines.delete(item.id);
    }
    this.baskets.set(member, lines);
    return { status: "SUCCESS", errorMessage: null, result: this.basket(member) };
  }

  private graphql(member: string | null, query: string, variables: Record<string, unknown>): Response {
    const name = /^\s*(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
    this.calls.push(`graphql ${name}`);
    const id = Number(variables.id);
    const items = (variables.items ?? []) as { id: number; quantity: number }[];
    switch (name) {
      case "Product": {
        const p = CATALOG.find((c) => c.id === id);
        return json(200, {
          data: {
            product: p && {
              id: p.id,
              title: p.title,
              brand: p.brand,
              salesUnitSize: p.size,
              summary: `Over ${p.title}`,
              category: "Zuivel/Melk",
              properties: [
                { code: "nutriscore", values: ["B"] },
                { code: "sp_include_dieet_vegetarisch", values: ["Vegetarisch"] },
              ],
              priceV2: { now: { amount: p.price }, was: { amount: p.price } },
              availability: { isOrderable: true },
              tradeItem: {
                gtin: "0871",
                ingredients: { statement: "Ingrediënten: MELK", allergens: { contains: ["Melk"], mayContain: [], freeFrom: [] } },
                nutritions: [{ basisQuantity: "100 Milliliter", nutrients: [{ name: "Energie", value: "195 kJ (46 kcal)" }] }],
              },
            },
          },
        });
      }
      case "FetchBonusPromotionWithProducts":
        return json(200, {
          data: {
            bonusPromotions:
              variables.id === "9001"
                ? [{ id: "9001", title: "Alle AH pasta", products: [{ ...basketProduct(CATALOG[1]!), brand: "AH", availability: { isOrderable: true } }] }]
                : [],
          },
        });
      case "FetchRecipes":
        return json(200, {
          data: {
            recipeSearchV2: {
              correctedSearchTerm: null,
              page: { total: 1 },
              result: [{ id: 501, title: "Penne met melksaus", time: { cook: 20 }, tags: [{ key: "menugang", value: "hoofdgerecht" }] }],
            },
          },
        });
      case "Recipe":
        return json(200, {
          data: {
            recipe:
              id === 501
                ? {
                    id: 501,
                    title: "Penne met melksaus",
                    description: "Snel klaar.",
                    cookTime: 20,
                    servings: { number: 4, type: "personen" },
                    ingredients: [{ id: 1, text: "300 g penne", quantity: 300, quantityUnit: { singular: "g", plural: "g" }, name: { singular: "penne", plural: null } }],
                    preparation: { steps: ["Kook de penne."] },
                    nutritions: { energy: { value: 500, unit: "kcal" } },
                  }
                : null,
          },
          // Albert Heijn reports a missing nutrition block next to the recipe.
          errors: [{ message: "Subgraph errors redacted" }],
        });
      case "Suggestions":
        return json(200, {
          data: { recipeProductSuggestionsV2: [{ optional: false, ingredient: { id: 1 }, productSuggestion: { quantity: 1, product: basketProduct(CATALOG[1]!) } }] },
        });
      case "Basket":
        return json(200, { data: { basket: this.basket(member) } });
      case "BasketItemsAdd":
        return json(200, { data: { basketItemsAdd: this.change(member, items, true) } });
      case "BasketItemsUpdate":
        return json(200, { data: { basketItemsUpdate: this.change(member, items, false) } });
      case "Slots":
        return json(200, {
          data: {
            orderDeliverySlots: [
              {
                date: "2030-01-01T23:00:00.000Z",
                dateFormatted: "2030-01-02",
                isFullyBooked: false,
                slots: [
                  { startTime: "2030-01-02T15:00:00.000Z", endTime: "2030-01-02T17:00:00.000Z", isFullyBooked: false, serviceCharge: { price: { amount: 5.95 }, defaultPrice: { amount: 7.95 } } },
                  { startTime: "2030-01-02T17:00:00.000Z", endTime: "2030-01-02T19:00:00.000Z", isFullyBooked: true, serviceCharge: { price: { amount: 7.95 }, defaultPrice: { amount: 7.95 } } },
                ],
                address: variables.address,
              },
            ],
          },
        });
      case "Orders":
        return json(200, {
          data: {
            orderFulfillments: {
              result: member && query.includes("OPEN") ? [{ orderId: 77, statusDescription: "Besteld", shoppingType: "DELIVERY", totalPrice: { totalPrice: { amount: 42.5 } }, delivery: { slot: { date: "2030-01-02", timeDisplay: "16:00 - 18:00" } } }] : [],
            },
          },
        });
      case "FetchMember":
        return json(200, {
          data: {
            member: member
              ? {
                  id: 1,
                  emailAddress: `${member}@example.com`,
                  name: { first: member, last: "Jansen" },
                  address: { street: "Dorpsstraat", houseNumber: 12, houseNumberExtra: "A", postalCode: "1234AB", city: "Ons Dorp" },
                  cards: { bonus: "2620000012345" },
                }
              : { id: 2, emailAddress: null, name: { first: null, last: null }, address: null, cards: null },
          },
        });
      default:
        this.unexpected.push(`graphql ${name}`);
        return json(400, { errors: [{ message: "Unknown operation", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] });
    }
  }

  private rest(member: string | null, url: URL): Response {
    const path = url.pathname.replace("/mobile-services/", "");
    this.calls.push(`GET ${path}`);
    const query = url.searchParams;
    switch (path) {
      case "product/search/v2": {
        const needle = (query.get("query") ?? "").toLowerCase();
        const hits = CATALOG.filter((p) => p.title.toLowerCase().includes(needle));
        return json(200, { page: { totalElements: hits.length }, products: hits.map(restProduct) });
      }
      case "product/search/v2/products": {
        const ids = query.getAll("ids").map(Number);
        return json(200, CATALOG.filter((p) => ids.includes(p.id)).map(restProduct));
      }
      case "bonuspage/v3/metadata":
        return json(200, {
          periods: [
            {
              bonusStartDate: BONUS_START,
              bonusEndDate: BONUS_END,
              tabs: [
                { urlMetadataList: [{ url: `bonuspage/v2/section/spotlight?date=${BONUS_START}`, bonusType: "SPOTLIGHT", description: "Uit de Bonusfolder", count: 1 }] },
                {
                  urlMetadataList: [
                    { url: `bonuspage/v2/section/spotlight?date=${BONUS_START}`, bonusType: "SPOTLIGHT", description: "Uit de Bonusfolder", count: 1 },
                    { url: `bonuspage/v2/section?date=${BONUS_START}&category=Pasta`, bonusType: "NATIONAL", description: "Pasta, rijst", count: 1 },
                    { url: `bonuspage/v2/section?date=${BONUS_START}&category=Zuivel`, bonusType: "NATIONAL", description: "Zuivel, eieren", count: 1 },
                  ],
                },
              ],
            },
          ],
        });
      case "bonuspage/v2/section/spotlight":
        return json(200, {
          sectionDescription: "Uit de Bonusfolder",
          bonusGroupOrProducts: [{ bonusGroup: { id: "9001", segmentDescription: "Alle AH pasta", discountDescription: "2 VOOR 1.50", category: "Pasta, rijst", bonusEndDate: BONUS_END } }],
        });
      case "bonuspage/v2/section":
        return json(
          200,
          query.get("category") === "Pasta"
            ? { sectionDescription: "Pasta, rijst", bonusGroupOrProducts: [{ bonusGroup: { id: "9001", segmentDescription: "Alle AH pasta", discountDescription: "2 VOOR 1.50", category: "Pasta, rijst" } }] }
            : { sectionDescription: "Zuivel, eieren", bonusGroupOrProducts: [{ product: { ...restProduct(CATALOG[0]!), isBonus: true, bonusMechanism: "25% korting", currentPrice: 0.97 } }] },
        );
      case "bonuspage/v1/personal":
        if (member === null) {
          this.unexpected.push("personal bonus for a visitor");
          return json(403, { error: "forbidden" });
        }
        return json(200, [
          { sectionDescription: "Voor jou", bonusGroupOrProducts: [{ bonusGroup: { id: "9500", segmentDescription: `Koffie voor ${member}`, discountDescription: "10% KORTING", activationStatus: "ACTIVATED" } }] },
        ]);
      case "order/v1/summaries/active":
        if (this.orderCheckDown) return json(503, { error: "unavailable" });
        return member !== null && this.booked.has(member) ? json(200, { id: 77, state: "REOPENED" }) : json(404, { error: "not_found" });
      default:
        this.unexpected.push(`GET ${path}`);
        return json(404, { error: "not_found" });
    }
  }

  readonly fetch: AhFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (this.down) throw new TypeError("fetch failed");
    if (url.origin !== "https://api.ah.nl") {
      this.unexpected.push(`request to ${url.origin}`);
      return json(404, {});
    }
    if (this.blocked) return new Response("<html>Access Denied</html>", { status: 403 });
    if (!headers.get("x-application") || !/^Appie\//.test(headers.get("user-agent") ?? "")) return json(500, { error: "missing app headers" });

    if (url.pathname.startsWith("/mobile-auth/v1/auth/token")) {
      const step = url.pathname.slice("/mobile-auth/v1/auth/token".length);
      this.calls.push(`token${step}`);
      if (body.clientId !== "appie-ios") return json(400, { message: "Incorrect request send by client", status: 400 });
      if (step === "/anonymous") return this.issue(null);
      if (step === "") {
        const member = this.codes.get(String(body.code));
        if (!member) return json(400, { message: "Incorrect request send by client", status: 400 });
        this.codes.delete(String(body.code));
        return this.issue(member);
      }
      if (step === "/refresh") {
        const token = String(body.refreshToken);
        if (!this.refresh.has(token)) return json(401, { error: "invalid_token" });
        const member = this.refresh.get(token)!;
        this.refresh.delete(token);
        this.refreshes++;
        return this.issue(member);
      }
      // Albert Heijn's app API has no working sign-out.
      if (step === "/logout") return json(404, { error: "not_found" });
      this.unexpected.push(`token${step}`);
      return json(404, {});
    }

    const token = this.access.get((headers.get("authorization") ?? "").replace(/^Bearer /, ""));
    if (!token || token.expiresAt < Date.now() / 1000) return json(401, { error: "invalid_token", error_description: "Invalid access token" });
    if (url.pathname === "/graphql" && init?.method === "POST") {
      return this.graphql(token.member, String(body.query), (body.variables ?? {}) as Record<string, unknown>);
    }
    if (url.pathname.startsWith("/mobile-services/") && (init?.method ?? "GET") === "GET") return this.rest(token.member, url);
    this.unexpected.push(`${init?.method ?? "GET"} ${url.pathname}`);
    return json(404, {});
  };
}
