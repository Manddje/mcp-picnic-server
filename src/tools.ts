import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import PicnicClient from "picnic-api";
import { z } from "zod";
import * as fmt from "./format.js";
import { DESTRUCTIVE, READ, toolRegistrar, WRITE, type ServerInfo } from "./mcp-tool.js";
import { classifyPicnicError, type Country } from "./picnic.js";

export type ToolContext = {
  picnic: PicnicClient;
  country: Country;
  /** Signs this session out at Picnic, which invalidates the user's tokens. */
  signOut: () => Promise<boolean>;
};

export const SERVER_INSTRUCTIONS = `Tools for the signed-in user's own Picnic account. Picnic is an online supermarket that delivers groceries in the Netherlands, Germany and France.

- Product ids look like "s1234567". Take them from tool results (search_products, get_favorites, get_cart, a recipe); never make one up.
- Products and recipes are in the language of the user's Picnic country, so search in that language (Dutch for NL, German for DE, French for FR), whatever language the user writes in.
- Prices are in euros. "was" is the regular price of a discounted product.
- A usual order: search_products, add_to_cart, get_delivery_slots, select_delivery_slot, then get_cart to summarise.
- These tools cannot place or pay for an order. When the cart is ready, tell the user to check out in the Picnic app.
- Ask before removing products the user didn't mention and before clear_cart.`;

const SESSION_EXPIRED =
  "The Picnic sign-in for this connection has expired or was ended. Ask the user to disconnect the Picnic connector in their app and connect it again to sign in.";

function explain(error: unknown): string {
  if (PicnicClient.isUnexpectedPageFormatError(error)) {
    return "Picnic changed how it serves this page, so this tool can't read it at the moment. The other tools still work.";
  }
  const { kind, status, code } = classifyPicnicError(error);
  switch (kind) {
    case "session":
      return SESSION_EXPIRED;
    case "throttled":
      return "Picnic is temporarily refusing requests. Wait a minute before trying again.";
    case "not_found":
      return "Not found. The id doesn't exist, or the product isn't available at the user's address.";
    default: {
      const message = error instanceof Error ? error.message.slice(0, 300) : "Unknown error";
      return status ? `Picnic answered with an error (status ${status}${code ? `, ${code}` : ""}): ${message}` : `Something went wrong: ${message}`;
    }
  }
}

const productId = z.string().trim().min(1).max(40).describe('A product id from a tool result, e.g. "s1234567".');
const recipeId = z.string().trim().min(1).max(64).describe("A recipe id from search_recipes, list_recipes or get_cart.");
const quantity = z.number().int().min(1).max(99);
const cartItems = z
  .array(z.object({ product_id: productId, quantity: quantity.default(1).describe("How many packages. Default 1.") }))
  .min(1)
  .max(60);

export function buildMcpServer(ctx: ToolContext, info: ServerInfo): McpServer {
  const server = new McpServer({ name: "picnic", title: "Picnic", ...info }, { instructions: SERVER_INSTRUCTIONS });
  const { picnic } = ctx;

  const tool = toolRegistrar(server, explain);

  /* ---------- Products ---------- */

  tool(
    "search_products",
    {
      title: "Search products",
      description:
        "Search the Picnic assortment. Returns products with their id, size, price and current deals. Products the user bought before are marked bought_before. Search in the language of the user's Picnic country.",
      input: {
        query: z.string().trim().min(1).max(100).describe('What to look for, e.g. "halfvolle melk" or "pasta penne".'),
        limit: z.number().int().min(1).max(40).default(12).describe("Maximum number of products. Default 12."),
      },
      annotations: READ,
    },
    async ({ query, limit }) => {
      const results = await picnic.catalog.getSearchResults(query);
      const seen = new Map<string, ReturnType<typeof fmt.productTile> & { bought_before?: true }>();
      for (const section of results.products?.sections ?? []) {
        for (const product of section.products) {
          const entry: ReturnType<typeof fmt.productTile> & { bought_before?: true } = seen.get(product.id) ?? fmt.productTile(product);
          if (section.type === "RFY") entry.bought_before = true;
          seen.set(product.id, entry);
        }
      }
      const products = [...seen.values()];
      return {
        query,
        searched_for_instead: results.correctedQuery,
        products: products.slice(0, limit),
        more_results: products.length > limit ? products.length - limit : undefined,
        hint: products.length === 0 ? "No products found. Try a shorter or more general term in the local language." : undefined,
      };
    },
  );

  tool(
    "get_product",
    {
      title: "Product details",
      description: "Everything about one product: description, ingredients, allergens, nutrition, deals and similar products.",
      input: { product_id: productId },
      annotations: READ,
    },
    async ({ product_id }) => {
      const product = await picnic.catalog.getProduct(product_id);
      const image = product.imageIds[0];
      return fmt.productDetails(product, image ? picnic.catalog.getImageUrl(image, "medium") : undefined);
    },
  );

  tool(
    "get_cheaper_alternatives",
    {
      title: "Cheaper alternatives",
      description: "Similar products that cost less per kilogram, litre or piece than the given product.",
      input: { product_id: productId },
      annotations: READ,
    },
    async ({ product_id }) => {
      const result = await picnic.catalog.getCheaperAlternatives(product_id);
      const per = (c: { unit: string; price: number } | null) => (c ? `${fmt.eur(c.price)}/${c.unit}` : undefined);
      return {
        product_id,
        price_per_unit: per(result.comparisonPrice),
        alternatives: result.alternatives.slice(0, 8).map((a) => ({
          product_id: a.id,
          name: a.name,
          size: a.unitQuantity,
          price: fmt.eur(a.displayPrice),
          price_per_unit: per(a.comparisonPrice),
        })),
      };
    },
  );

  tool(
    "get_favorites",
    {
      title: "Products you buy often",
      description:
        "The products the user buys regularly, grouped by aisle. Useful for “my usual groceries”. Pass aisle_id for the complete list of one aisle.",
      input: { aisle_id: z.string().trim().max(60).optional().describe('An aisle id from this tool\'s own result, e.g. "DAIRY".') },
      annotations: READ,
    },
    async ({ aisle_id }) => {
      if (aisle_id) {
        const products = await picnic.catalog.getFavoritesInAisle(aisle_id);
        return { aisle_id, products: products.map(fmt.productTile) };
      }
      const favorites = await picnic.catalog.getFavorites();
      return {
        aisles: favorites.aisles
          .filter((a) => a.products.length > 0 || !a.complete)
          .map((a) => ({
            aisle_id: a.id,
            name: a.title,
            products: a.products.slice(0, 15).map(fmt.productTile),
            more_with_aisle_id: !a.complete || a.products.length > 15 || undefined,
          })),
      };
    },
  );

  tool(
    "get_promotions",
    {
      title: "Current deals",
      description:
        "This week's promotions, in sections (personal deals, featured, per category). A section can also list promotion groups such as “2 for €3.99 on brand X”; pass a group_id to see the products of that group.",
      input: {
        group_id: z.string().trim().max(80).optional().describe("A promotion group id from this tool's own result."),
        products_per_section: z.number().int().min(1).max(30).default(6).describe("Maximum products per section. Default 6."),
      },
      annotations: READ,
    },
    async ({ group_id, products_per_section }) => {
      if (group_id) {
        const group = await picnic.catalog.getPromotionGroup(group_id);
        return { group_id: group.id, name: group.name, products: group.products.map(fmt.productTile) };
      }
      const promotions = await picnic.catalog.getPromotions();
      return {
        sections: promotions.sections.map((s) => ({
          title: s.title,
          products: s.products.slice(0, products_per_section).map(fmt.productTile),
          more_products: s.products.length > products_per_section ? s.products.length - products_per_section : undefined,
          groups: s.groups.map((g) => ({ group_id: g.id, name: g.name, deal: g.label, example: g.example })),
        })),
      };
    },
  );

  /* ---------- Cart ---------- */

  tool(
    "get_cart",
    {
      title: "View cart",
      description: "The shopping cart: products, quantities, prices, total, the chosen delivery slot and whether the minimum order value is reached.",
      annotations: READ,
    },
    async () => fmt.cart(await picnic.cart.getCart()),
  );

  /** Applies a cart change per product and reports the cart afterwards, with the products that failed. */
  async function changeCart(items: z.infer<typeof cartItems>, change: (id: string, count: number) => Promise<PicnicClient.Types.cart.Cart>) {
    let latest: PicnicClient.Types.cart.Cart | null = null;
    const failed: { product_id: string; reason: string }[] = [];
    for (const item of items) {
      try {
        latest = await change(item.product_id, item.quantity);
      } catch (error) {
        if (classifyPicnicError(error).kind === "session") throw error;
        failed.push({ product_id: item.product_id, reason: explain(error) });
      }
    }
    return { failed, cart: fmt.cart(latest ?? (await picnic.cart.getCart())) };
  }

  tool(
    "add_to_cart",
    {
      title: "Add to cart",
      description: "Add one or more products to the cart. Adding a product that is already in the cart raises its quantity. Returns the updated cart.",
      input: { items: cartItems.describe("The products to add.") },
      annotations: WRITE,
    },
    ({ items }) => changeCart(items, (id, count) => picnic.cart.addProductToCart(id, count)),
  );

  tool(
    "remove_from_cart",
    {
      title: "Remove from cart",
      description: "Lower the quantity of one or more products in the cart, or remove them by passing their full quantity. Returns the updated cart.",
      input: { items: cartItems.describe("The products to remove and how many of each.") },
      annotations: DESTRUCTIVE,
    },
    ({ items }) => changeCart(items, (id, count) => picnic.cart.removeProductFromCart(id, count)),
  );

  tool(
    "clear_cart",
    {
      title: "Empty cart",
      description: "Remove everything from the cart. Only use this when the user asked to empty the cart.",
      annotations: DESTRUCTIVE,
    },
    async () => fmt.cart(await picnic.cart.clearCart()),
  );

  /* ---------- Delivery ---------- */

  tool(
    "get_delivery_slots",
    {
      title: "Delivery slots",
      description: "The delivery windows the user can choose from, with the selected one. Times are in the user's local time.",
      input: { include_unavailable: z.boolean().default(false).describe("Also list slots that are full or closed. Default false.") },
      annotations: READ,
    },
    async ({ include_unavailable }) => {
      const { slots, selectedSlot } = await picnic.cart.getDeliverySlots();
      return {
        selected_slot_id: selectedSlot?.slotId,
        selected_by_user: selectedSlot?.isExplicitSelection,
        slots: slots.filter((s) => include_unavailable || s.isAvailable || s.isSelected).map(fmt.deliverySlot),
      };
    },
  );

  tool(
    "select_delivery_slot",
    {
      title: "Choose delivery slot",
      description: "Choose the delivery window for the current cart. This reserves nothing and orders nothing; the user still checks out in the Picnic app.",
      input: { slot_id: z.string().trim().min(1).max(80).describe("A slot_id from get_delivery_slots.") },
      annotations: { ...WRITE, idempotentHint: true },
    },
    async ({ slot_id }) => fmt.cart(await picnic.cart.setDeliverySlot(slot_id)),
  );

  tool(
    "list_deliveries",
    {
      title: "Orders and deliveries",
      description: "The user's upcoming and past deliveries, newest first.",
      input: {
        status: z.enum(["CURRENT", "COMPLETED", "CANCELLED"]).optional().describe("Only deliveries with this status. CURRENT means ordered but not delivered yet."),
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of deliveries. Default 10."),
      },
      annotations: READ,
    },
    async ({ status, limit }) => {
      const deliveries = await picnic.delivery.getDeliverySummaries(status ? [status] : []);
      return { deliveries: deliveries.slice(0, limit).map(fmt.deliverySummary), more: deliveries.length > limit ? deliveries.length - limit : undefined };
    },
  );

  tool(
    "get_delivery",
    {
      title: "Delivery details",
      description: "One delivery with all its products and prices. Useful to reorder a past order or check what is coming.",
      input: { delivery_id: z.string().trim().min(1).max(80).describe("A delivery_id from list_deliveries.") },
      annotations: READ,
    },
    async ({ delivery_id }) => fmt.delivery(await picnic.delivery.getDelivery(delivery_id)),
  );

  tool(
    "track_delivery",
    {
      title: "Track delivery",
      description: "Where today's delivery is: whether the driver is on the way and the expected arrival time.",
      input: { delivery_id: z.string().trim().min(1).max(80).describe("The delivery_id of a CURRENT delivery from list_deliveries.") },
      annotations: READ,
    },
    async ({ delivery_id }) => {
      const position = await picnic.delivery.getDeliveryPosition(delivery_id);
      return {
        delivery_id,
        driver_on_the_way: position.inProgress,
        expected_arrival: position.eta ? new Date(position.eta).toISOString() : undefined,
        arrival_window: position.etaWindowStart && position.etaWindowEnd ? `${position.etaWindowStart} – ${position.etaWindowEnd}` : undefined,
      };
    },
  );

  /* ---------- Recipes ---------- */

  tool(
    "search_recipes",
    {
      title: "Search recipes",
      description: "Search Picnic's recipes. Every recipe can be added to the cart with its ingredients in one go.",
      input: { query: z.string().trim().min(1).max(100).describe('What to cook, e.g. "lasagne" or "vegetarisch".') },
      annotations: READ,
    },
    async ({ query }) => {
      const results = await picnic.catalog.getSearchResults(query, { context: "MEALS" });
      return { query, recipes: results.recipes.slice(0, 20).map(fmt.recipeSummary) };
    },
  );

  tool(
    "list_recipes",
    {
      title: "Your recipes",
      description: "The recipes the user saved from Picnic's cookbook (saved) or made themselves (own).",
      input: { kind: z.enum(["saved", "own"]).default("saved").describe("saved: saved Picnic recipes. own: recipes the user created.") },
      annotations: READ,
    },
    async ({ kind }) => {
      const recipes = kind === "own" ? await picnic.recipe.getUserDefinedRecipes() : await picnic.recipe.getSavedRecipes();
      return { kind, recipes: recipes.map(fmt.recipeSummary) };
    },
  );

  tool(
    "get_recipe",
    {
      title: "Recipe details",
      description: "A recipe with its ingredients (as Picnic products with prices), preparation steps, nutrition and allergens.",
      input: { recipe_id: recipeId, portions: z.number().int().min(1).max(20).optional().describe("Number of portions. Default: the recipe's own.") },
      annotations: READ,
    },
    async ({ recipe_id, portions }) => {
      try {
        return fmt.recipe(await picnic.recipe.getRecipe(recipe_id, { portions, resolveIngredientNames: true }));
      } catch (error) {
        // Looking up missing ingredient names takes extra requests that can fail; the recipe itself is what matters.
        if (classifyPicnicError(error).kind === "session") throw error;
        return fmt.recipe(await picnic.recipe.getRecipe(recipe_id, { portions }));
      }
    },
  );

  tool(
    "add_recipe_to_cart",
    {
      title: "Add recipe to cart",
      description: "Add the ingredients of a recipe to the cart. Pantry items (salt, oil) are left out, as in the Picnic app. Returns the updated cart.",
      input: { recipe_id: recipeId, portions: z.number().int().min(1).max(20).optional().describe("Number of portions. Default: the recipe's own.") },
      annotations: WRITE,
    },
    async ({ recipe_id, portions }) => {
      const result = await picnic.recipe.addRecipeToCart(recipe_id, portions ? { portions } : undefined);
      return {
        portions: result.assignedNumberOfPortions,
        some_ingredients_unavailable: result.anyUnavailableIngredient || undefined,
        cart: fmt.cart(await picnic.cart.getCart()),
      };
    },
  );

  tool(
    "remove_recipe_from_cart",
    {
      title: "Remove recipe from cart",
      description: "Remove a recipe and its ingredients from the cart. Returns the updated cart.",
      input: { recipe_id: recipeId },
      annotations: DESTRUCTIVE,
    },
    async ({ recipe_id }) => {
      await picnic.recipe.removeRecipeFromCart(recipe_id);
      return fmt.cart(await picnic.cart.getCart());
    },
  );

  tool(
    "create_recipe",
    {
      title: "Create your own recipe",
      description:
        "Save a recipe of the user's own in their Picnic cookbook: a name, the Picnic products it needs and optionally the preparation as a note. It can then be added to the cart with add_recipe_to_cart.",
      input: {
        name: z.string().trim().min(1).max(43).describe("The recipe name, at most 43 characters."),
        portions: z.number().int().min(1).max(20).default(4).describe("The number of portions the quantities are for. Default 4."),
        ingredients: z
          .array(z.object({ product_id: productId, quantity: quantity.default(1).describe("How many packages. Default 1.") }))
          .min(1)
          .max(40)
          .describe("The Picnic products of the recipe. Find them with search_products first."),
        note: z.string().trim().max(4500).optional().describe("Preparation steps or other notes, as plain text with one step per line."),
      },
      annotations: WRITE,
    },
    async ({ name, portions, ingredients, note }) => {
      const created = await picnic.recipe.createUserDefinedRecipe(
        name,
        ingredients.map((i) => ({ sellingUnitId: i.product_id, quantity: i.quantity })),
        portions,
      );
      let noteSaved: boolean | undefined;
      if (note) {
        const html = note
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => `<p>${line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
          .join("");
        noteSaved = await picnic.recipe.setUserDefinedRecipeNote(created.sellingGroupId, html).then(
          () => true,
          () => false,
        );
      }
      return { recipe_id: created.sellingGroupId, name, portions, note_saved: noteSaved };
    },
  );

  tool(
    "delete_recipe",
    {
      title: "Delete your own recipe",
      description: "Delete a recipe the user created themselves (kind own). Picnic's recipes can't be deleted. Only use this when the user asked for it.",
      input: { recipe_id: recipeId },
      annotations: DESTRUCTIVE,
    },
    async ({ recipe_id }) => {
      await picnic.recipe.deleteUserDefinedRecipe(recipe_id);
      return { deleted: recipe_id };
    },
  );

  /* ---------- Account ---------- */

  tool(
    "get_account",
    {
      title: "Account",
      description: "Whose Picnic account is connected: name, delivery address and country. The country tells which language to search in.",
      annotations: READ,
    },
    async () => {
      const user = await picnic.user.getUser();
      const a = user.address;
      return {
        name: `${user.firstname} ${user.lastname}`.trim(),
        email: user.contact_email,
        address: a && `${a.street} ${a.house_number}${a.house_number_ext ?? ""}, ${a.postcode} ${a.city}`,
        country: ctx.country,
        search_language: { NL: "Dutch", DE: "German", FR: "French" }[ctx.country],
        deliveries_received: user.completed_deliveries,
      };
    },
  );

  tool(
    "disconnect_account",
    {
      title: "Disconnect Picnic account",
      description:
        "Sign this connection out of Picnic. After this every tool fails until the user connects again. Only use this when the user explicitly asks to disconnect or sign out.",
      annotations: { ...DESTRUCTIVE, idempotentHint: true },
    },
    async () => {
      const done = await ctx.signOut();
      return done
        ? { disconnected: true, next: "The user can also remove the connector in their app. To use Picnic again they connect and sign in again." }
        : { disconnected: false, next: "Signing out at Picnic failed. The user can remove the connector in their app, and change their Picnic password to end all sessions." };
    },
  );

  return server;
}
