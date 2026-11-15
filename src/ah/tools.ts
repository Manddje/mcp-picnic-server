import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DESTRUCTIVE, READ, toolRegistrar, WRITE, type ServerInfo } from "../mcp-tool.js";
import * as api from "./api.js";
import { classifyAhError, type AhClient } from "./client.js";
import * as fmt from "./format.js";
import type { AhPublic } from "./public.js";

export type AhToolContext = {
  ah: AhClient;
  /** False when the user connected without an Albert Heijn account. */
  member: boolean;
  /** What is the same for every user, fetched without this user's token. */
  shared: AhPublic;
  /** Ends this sign-in, so its tokens stop working. */
  signOut: () => Promise<void>;
  /** Tells the server Albert Heijn refused this user's token, so the app gets new tokens. */
  tokenRefused: () => void;
};

export const AH_SERVER_INSTRUCTIONS = `Tools for Albert Heijn, a supermarket in the Netherlands, and for the user's own Albert Heijn account when they signed in.

- Product ids are numbers, such as 220739. Take them from tool results (search_products, get_promotions, get_cart, a recipe); never make one up.
- Products and recipes are in Dutch, so search in Dutch, whatever language the user writes in.
- Prices are in euros, for one package. "was" is the regular price of a discounted product. "deal" is a bonus offer in Albert Heijn's words, such as "2 voor 3.99" or "1 + 1 gratis"; it can need more than one package.
- Albert Heijn's shopping list and online basket are one and the same: get_cart shows it and add_to_cart fills it. A usual round: search_products, add_to_cart, then get_cart to summarise.
- These tools cannot place or pay for an order, and cannot book a delivery. When the basket is ready, tell the user to pick a delivery time and check out in the Albert Heijn app. get_delivery_slots only shows the times and what they cost.
- Once a delivery or pick-up is booked, the basket is a real order. The tools then refuse to change it; the user changes it in the Albert Heijn app.
- A user can be connected without an Albert Heijn account. Searching, deals, recipes and delivery times still work then; get_account says which it is.
- Ask before removing products the user didn't mention and before clear_cart.`;

const NEEDS_ACCOUNT =
  "This needs the user's Albert Heijn account, and they connected without one. To use it they disconnect the Albert Heijn connector in their app, connect it again and sign in at Albert Heijn.";
const BOOKED =
  "Nothing was changed. A delivery or pick-up is booked, so the basket is now a real order, and these tools don't change orders. The user can change it in the Albert Heijn app.";
const OUTCOME_UNKNOWN = "Albert Heijn didn't answer, so it is unknown whether the change was made. Call get_cart to see the basket before trying again.";

/** An answer a tool gives on purpose, in words for the model. */
class Refusal extends Error {}

function describe(error: unknown): string {
  const { kind, status } = classifyAhError(error);
  switch (kind) {
    case "session":
      return "Albert Heijn no longer accepts this connection's sign-in. Try once more: the app renews it by itself. If it fails again, the user disconnects the Albert Heijn connector in their app and connects it again.";
    case "throttled":
      return "Albert Heijn is temporarily refusing requests. Wait a minute before trying again.";
    case "refused":
      return "Albert Heijn refused this request.";
    case "not_found":
      return "Not found at Albert Heijn. The id doesn't exist, or the product is no longer sold.";
    case "unavailable":
      return "Albert Heijn can't be reached right now. Try again in a moment.";
    case "changed":
      return "Albert Heijn changed how it answers this, so this tool can't read it at the moment. The other tools may still work.";
    default: {
      const message = error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
      return status ? `Albert Heijn answered with an error (status ${status}): ${message}` : `Something went wrong: ${message}`;
    }
  }
}

const productId = z.coerce.number().int().min(1).max(999_999_999).describe("A product id from a tool result, e.g. 220739.");
const quantity = z.number().int().min(1).max(99);
const cartItems = z
  .array(z.object({ product_id: productId, quantity: quantity.default(1).describe("How many packages. Default 1.") }))
  .min(1)
  .max(60);

/** Runs `run` for every item, a few at a time, and keeps the order. */
async function each<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));
  return results;
}

export function buildAhMcpServer(ctx: AhToolContext, info: ServerInfo): McpServer {
  const server = new McpServer({ name: "albert-heijn", title: "Albert Heijn", ...info }, { instructions: AH_SERVER_INSTRUCTIONS });
  const { ah, shared } = ctx;

  const explain = (error: unknown): string => {
    if (error instanceof Refusal) return error.message;
    if (classifyAhError(error).kind === "session") ctx.tokenRefused();
    return describe(error);
  };
  const tool = toolRegistrar(server, explain);

  const needsAccount = () => {
    if (!ctx.member) throw new Refusal(NEEDS_ACCOUNT);
  };

  /* ---------- Products ---------- */

  tool(
    "search_products",
    {
      title: "Search products",
      description:
        "Search Albert Heijn's assortment. Returns products with their id, size, price and bonus deal. Products the user bought before are marked bought_before. Search in Dutch.",
      input: {
        query: z.string().trim().min(1).max(100).describe('What to look for, e.g. "halfvolle melk" or "pasta penne".'),
        limit: z.number().int().min(1).max(30).default(12).describe("Maximum number of products. Default 12."),
        sort: z.enum(["relevance", "price_low_high", "price_high_low"]).default("relevance").describe("Order of the results. Default relevance."),
      },
      annotations: READ,
    },
    async ({ query, limit, sort }) => {
      const sortOn = ({ relevance: "RELEVANCE", price_low_high: "PRICELOWHIGH", price_high_low: "PRICEHIGHLOW" } as const)[sort];
      // A few more than asked for: sponsored products are left out.
      const result = await api.searchProducts(ah, query, Math.min(limit + 6, 36), sortOn);
      const products = (result.products ?? []).filter((p) => !p.isSponsored && p.webshopId !== undefined).map(fmt.product);
      const total = result.page?.totalElements ?? products.length;
      return {
        query,
        products: products.slice(0, limit),
        more_results: total > limit ? total - limit : undefined,
        hint: products.length === 0 ? "No products found. Try a shorter or more general Dutch term." : undefined,
      };
    },
  );

  tool(
    "get_product",
    {
      title: "Product details",
      description: "Everything about one product: price and bonus deal, description, ingredients, allergens, nutrition and diet labels.",
      input: { product_id: productId },
      annotations: READ,
    },
    async ({ product_id }) => {
      // The label and the current price come from two calls; either one alone is still an answer.
      let failure: unknown;
      const soft = <T>(call: Promise<T>): Promise<T | null> =>
        call.catch((error: unknown) => {
          if (classifyAhError(error).kind === "session") throw error;
          failure = error;
          return null;
        });
      const [detail, products] = await Promise.all([soft(api.productDetail(ah, product_id)), soft(api.productsByIds(ah, [product_id]))]);
      const live = products?.find((p) => p.webshopId === product_id);
      if (detail) return fmt.productDetails(detail, live);
      if (live) return fmt.product(live);
      // Albert Heijn answers the label of an unknown product with an error, so the list of products decides.
      if (products) throw new Refusal("Not found at Albert Heijn. The id doesn't exist, or the product is no longer sold.");
      throw failure;
    },
  );

  tool(
    "get_promotions",
    {
      title: "Bonus deals",
      description:
        "Albert Heijn's bonus deals of this week or the next. Without arguments: the featured deals and the names of the sections. Pass section for all deals of one section, search to look through every section, personal for the user's own bonus offers, or group_id for the products of a deal that covers a group.",
      input: {
        section: z.string().trim().min(1).max(60).optional().describe('A section name from this tool\'s own result, e.g. "Kaas".'),
        search: z.string().trim().min(1).max(60).optional().describe('Words a deal should contain, in Dutch, e.g. "koffie".'),
        personal: z.boolean().default(false).describe("The user's personal bonus offers instead of the weekly ones. Needs their account."),
        group_id: z.string().trim().min(1).max(40).optional().describe("A group_id from this tool's own result, to list the products of that deal."),
        week: z.enum(["current", "next"]).default("current").describe("This week's deals or next week's. Next week's appear a few days ahead."),
        limit: z.number().int().min(1).max(100).default(30).describe("Maximum number of deals. Default 30."),
      },
      annotations: READ,
    },
    async ({ section, search, personal, group_id, week, limit }) => {
      const periods = (await shared.get("bonus:periods", (pub) => api.bonusPeriods(pub))).filter((p) => p.bonusStartDate && p.bonusEndDate);
      const day = fmt.today();
      const current = periods.find((p) => p.bonusStartDate! <= day && day <= p.bonusEndDate!) ?? periods[0];
      const period = week === "next" ? periods.find((p) => current && p.bonusStartDate! > current.bonusStartDate!) : current;
      if (!period) throw new Refusal(week === "next" ? "Next week's bonus deals aren't published yet." : "Albert Heijn lists no bonus deals right now.");
      const span = { from: period.bonusStartDate!, until: period.bonusEndDate! };

      if (group_id) {
        const promotion = await shared.get(`bonus:group:${group_id}:${span.from}`, (pub) => api.bonusGroup(pub, group_id, span.from, span.until));
        if (!promotion) throw new Refusal(`No bonus deal with group_id ${group_id} in the week of ${span.from}.`);
        return { week: span, ...fmt.promotion(promotion) };
      }

      const offers = (sections: api.RawBonusSection[]) => {
        const seen = new Set<string>();
        const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        const all = sections
          .flatMap((s) => (s.bonusGroupOrProducts ?? []).map((entry) => fmt.bonusOffer(entry, s.sectionDescription)))
          .filter((offer) => offer !== undefined)
          .filter((offer) => {
            const key = "group_id" in offer ? `g${offer.group_id}` : `p${offer.product_id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            const text = `${offer.name ?? ""} ${offer.deal ?? ""} ${offer.category ?? ""}`.toLowerCase();
            return words.every((word) => text.includes(word));
          });
        return { deals: all.slice(0, limit), more_deals: all.length > limit ? all.length - limit : undefined };
      };

      if (personal) {
        needsAccount();
        return { week: span, personal: true, ...offers(await api.personalBonus(ah, span.from)) };
      }

      const entries = [...new Map((period.tabs ?? []).flatMap((t) => t.urlMetadataList ?? []).filter((e) => e.url).map((e) => [e.url!, e])).values()];
      const weekly = entries.filter((e) => e.bonusType === "NATIONAL");
      const sectionNames = [...new Set(weekly.map((e) => e.description).filter(Boolean))];
      let chosen = entries.filter((e) => e.bonusType === "SPOTLIGHT");
      if (section) {
        const needle = section.toLowerCase();
        chosen = weekly.filter((e) => e.description?.toLowerCase().includes(needle));
        if (chosen.length === 0) throw new Refusal(`No bonus section matches "${section}". The sections are: ${sectionNames.join("; ")}.`);
      } else if (search) {
        chosen = weekly;
      }
      const sections = await each(chosen, (e) => shared.get(`bonus:section:${e.url}`, (pub) => api.bonusSection(pub, e.url!)));
      return {
        week: span,
        showing: section ? undefined : search ? undefined : "the featured deals; pass section or search for the others",
        ...offers(sections),
        sections: section || search ? undefined : sectionNames,
      };
    },
  );

  /* ---------- Recipes ---------- */

  tool(
    "search_recipes",
    {
      title: "Search recipes",
      description: "Search Allerhande, Albert Heijn's recipes. Search in Dutch.",
      input: {
        query: z.string().trim().min(1).max(100).describe('What to cook, e.g. "lasagne" or "vegetarisch".'),
        limit: z.number().int().min(1).max(30).default(10).describe("Maximum number of recipes. Default 10."),
      },
      annotations: READ,
    },
    async ({ query, limit }) => {
      const result = await api.searchRecipes(ah, query, limit);
      const total = result.page?.total ?? 0;
      return {
        query,
        searched_for_instead: result.correctedSearchTerm,
        recipes: (result.result ?? []).map(fmt.recipeSummary),
        more_results: total > limit ? total - limit : undefined,
      };
    },
  );

  tool(
    "get_recipe",
    {
      title: "Recipe details",
      description:
        "An Allerhande recipe with its ingredients, the Albert Heijn product suggested for each ingredient, preparation steps and nutrition. Put its products in the basket with add_to_cart.",
      input: {
        recipe_id: z.coerce.number().int().min(1).max(999_999_999).describe("A recipe id from search_recipes."),
        portions: z.number().int().min(1).max(20).optional().describe("Number of portions to scale the ingredients to. Default: the recipe's own."),
      },
      annotations: READ,
    },
    async ({ recipe_id, portions }) => {
      const [recipe, suggestions] = await Promise.all([
        api.recipe(ah, recipe_id),
        // The products are an extra; the recipe is what matters.
        api.recipeSuggestions(ah, recipe_id).catch(() => []),
      ]);
      if (!recipe) throw new Refusal(`No Allerhande recipe with id ${recipe_id}.`);
      return fmt.recipe(recipe, suggestions, portions);
    },
  );

  /* ---------- Basket ---------- */

  tool(
    "get_cart",
    {
      title: "View basket",
      description: "The user's Albert Heijn basket, which is also their shopping list: products, quantities and prices, and whether a delivery is booked.",
      annotations: READ,
    },
    async () => {
      needsAccount();
      return fmt.basket(await api.basket(ah));
    },
  );

  /**
   * The basket, for a tool that is about to change it. Refuses when a delivery or pick-up is
   * booked, because the change would then land in a real order; and refuses when that can't be
   * checked.
   */
  async function basketToChange(): Promise<api.RawBasket> {
    needsAccount();
    let basket: api.RawBasket;
    let booked: boolean;
    try {
      [basket, booked] = await Promise.all([api.basket(ah), api.hasActiveOrder(ah)]);
    } catch (error) {
      if (classifyAhError(error).kind === "session") throw error;
      throw new Refusal(`Nothing was changed, because it could not be checked whether a delivery is booked. ${describe(error)}`);
    }
    if (booked || fmt.orderBooked(basket)) throw new Refusal(BOOKED);
    return basket;
  }

  /** Makes a change and returns the basket afterwards. */
  async function change(run: () => Promise<api.RawBasket | null>): Promise<api.RawBasket> {
    try {
      return (await run()) ?? (await api.basket(ah));
    } catch (error) {
      if (classifyAhError(error).kind === "unavailable") throw new Refusal(OUTCOME_UNKNOWN);
      throw error;
    }
  }

  /** The asked quantities per product, with a product that is listed twice added up. */
  function perProduct(items: z.infer<typeof cartItems>): Map<number, number> {
    const wanted = new Map<number, number>();
    for (const item of items) wanted.set(item.product_id, (wanted.get(item.product_id) ?? 0) + item.quantity);
    return wanted;
  }

  tool(
    "add_to_cart",
    {
      title: "Add to basket",
      description:
        "Add one or more products to the basket. Adding a product that is already in the basket raises its quantity. Returns the updated basket. Refused when a delivery is booked.",
      input: { items: cartItems.describe("The products to add.") },
      annotations: WRITE,
    },
    async ({ items }) => {
      const before = fmt.quantities((await basketToChange()).itemsInList);
      const wanted = perProduct(items);
      const after = await change(() => api.basketAdd(ah, [...wanted].map(([id, count]) => ({ id, quantity: count }))));
      const now = fmt.quantities(after.itemsInList);
      return {
        not_added: [...wanted].filter(([id, count]) => (now.get(id) ?? 0) < (before.get(id) ?? 0) + count).map(([id]) => id),
        cart: fmt.basket(after),
      };
    },
  );

  tool(
    "remove_from_cart",
    {
      title: "Remove from basket",
      description:
        "Lower the quantity of one or more products in the basket, or remove them by passing their full quantity. Returns the updated basket. Refused when a delivery is booked.",
      input: { items: cartItems.describe("The products to remove and how many of each.") },
      annotations: DESTRUCTIVE,
    },
    async ({ items }) => {
      const basket = await basketToChange();
      const before = fmt.quantities(basket.itemsInList);
      const wanted = perProduct(items);
      const changes = [...wanted].filter(([id]) => before.has(id)).map(([id, count]) => ({ id, quantity: Math.max(0, before.get(id)! - count) }));
      const after = changes.length ? await change(() => api.basketUpdate(ah, changes)) : basket;
      return { not_in_cart: [...wanted.keys()].filter((id) => !before.has(id)), cart: fmt.basket(after) };
    },
  );

  tool(
    "clear_cart",
    {
      title: "Empty basket",
      description: "Remove every product from the basket. Notes on the list stay. Only use this when the user asked to empty the basket. Refused when a delivery is booked.",
      annotations: DESTRUCTIVE,
    },
    async () => {
      const basket = await basketToChange();
      const ids = [...fmt.quantities(basket.itemsInList).keys()];
      const after = ids.length ? await change(() => api.basketUpdate(ah, ids.map((id) => ({ id, quantity: 0 })))) : basket;
      return fmt.basket(after);
    },
  );

  /* ---------- Delivery and orders ---------- */

  tool(
    "get_delivery_slots",
    {
      title: "Delivery times",
      description:
        "The home delivery times Albert Heijn offers at an address, and what each costs. This only shows them: booking one is done in the Albert Heijn app. Without an address, the address of the user's account is used.",
      input: {
        street: z.string().trim().min(1).max(80).optional().describe("Street name, without the house number."),
        house_number: z.number().int().min(1).max(99_999).optional().describe("House number, without an addition."),
        house_number_addition: z.string().trim().max(10).optional().describe('Addition to the house number, e.g. "A".'),
        postal_code: z.string().trim().min(6).max(7).optional().describe('Dutch postal code, e.g. "1506 MA".'),
        city: z.string().trim().min(1).max(60).optional(),
        days: z.number().int().min(1).max(14).default(5).describe("How many days to show. Default 5."),
        include_full: z.boolean().default(false).describe("Also list times that are fully booked. Default false."),
      },
      annotations: READ,
    },
    async ({ street, house_number, house_number_addition, postal_code, city, days, include_full }) => {
      let address: api.SlotAddress;
      if (street && house_number && postal_code && city) {
        address = { street, houseNumber: house_number, postalCode: postal_code, city, ...(house_number_addition ? { houseNumberExtra: house_number_addition } : {}) };
      } else {
        const missing = "Give street, house_number, postal_code and city.";
        if (!ctx.member) throw new Refusal(`The user connected without an Albert Heijn account, so there is no address on file. ${missing}`);
        const a = (await api.member(ah)).address;
        const houseNumber = Number(a?.houseNumber);
        if (!a?.street || !a.postalCode || !a.city || !Number.isInteger(houseNumber)) {
          throw new Refusal(`The user's Albert Heijn account has no complete address. ${missing}`);
        }
        address = { street: a.street, houseNumber, postalCode: a.postalCode, city: a.city, ...(a.houseNumberExtra ? { houseNumberExtra: a.houseNumberExtra } : {}) };
      }
      const all = (await api.deliverySlots(ah, address)).map((day) => fmt.slotDay(day, include_full)).filter((day) => day.slots.length > 0);
      return {
        address: `${address.street} ${address.houseNumber}${address.houseNumberExtra ?? ""}, ${address.postalCode} ${address.city}`,
        days: all.slice(0, days),
        more_days: all.length > days ? all.length - days : undefined,
        hint: all.length === 0 ? "No delivery times. Albert Heijn may not deliver at this address, or everything is fully booked." : undefined,
        booking: "The user books a time in the Albert Heijn app.",
      };
    },
  );

  tool(
    "list_orders",
    {
      title: "Orders",
      description: "The user's online orders at Albert Heijn: the ones that are coming (open) or the earlier ones (past).",
      input: {
        status: z.enum(["open", "past"]).default("open").describe("open: ordered but not delivered yet. past: delivered or picked up."),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of orders. Default 10."),
      },
      annotations: READ,
    },
    async ({ status, limit }) => {
      needsAccount();
      const orders = (await api.orders(ah, status === "open" ? "OPEN" : "CLOSED")).map(fmt.order).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      return { status, orders: orders.slice(0, limit), more: orders.length > limit ? orders.length - limit : undefined };
    },
  );

  /* ---------- Account ---------- */

  tool(
    "get_account",
    {
      title: "Account",
      description: "Whose Albert Heijn account is connected, or that the user connected without one. Tells which tools work.",
      annotations: READ,
    },
    async () => {
      if (!ctx.member) {
        return {
          signed_in: false,
          works: "Searching products and recipes, bonus deals and delivery times.",
          needs_an_account: "The basket, orders and personal bonus offers. To use them the user disconnects the Albert Heijn connector in their app, connects it again and signs in at Albert Heijn.",
          search_language: "Dutch",
        };
      }
      const m = await api.member(ah);
      return {
        signed_in: true,
        name: [m.name?.first, m.name?.last].filter(Boolean).join(" "),
        email: m.emailAddress,
        address: fmt.address(m.address),
        bonus_card: fmt.masked(m.cards?.bonus),
        search_language: "Dutch",
      };
    },
  );

  tool(
    "disconnect_account",
    {
      title: "Disconnect Albert Heijn",
      description:
        "End this connection to Albert Heijn. After this every tool fails until the user connects again. Only use this when the user explicitly asks to disconnect or sign out.",
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async () => {
      await ctx.signOut();
      return {
        disconnected: true,
        next: "The user can also remove the connector in their app. To use Albert Heijn again they connect and sign in again. Their sign-in in the Albert Heijn app itself is not affected.",
      };
    },
  );

  return server;
}
