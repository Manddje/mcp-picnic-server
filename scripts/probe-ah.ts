/**
 * Runs the Albert Heijn calls that need no account against the live API and prints what comes
 * back, cut short. Albert Heijn changes its app's API without notice; when a tool stops working,
 * this shows what the answer looks like now.
 *
 *   npx tsx scripts/probe-ah.ts            every call
 *   npx tsx scripts/probe-ah.ts product    only the calls whose name contains "product"
 */
import * as api from "../src/ah/api.js";
import { AhAuth, AhClient, classifyAhError } from "../src/ah/client.js";

const only = process.argv[2]?.toLowerCase();
const short = (value: unknown, length = 700) => {
  const text = JSON.stringify(value);
  return text === undefined ? "undefined" : text.length > length ? `${text.slice(0, length)}… (${text.length} characters)` : text;
};

async function probe(name: string, run: () => Promise<unknown>): Promise<unknown> {
  if (only && !name.toLowerCase().includes(only)) return undefined;
  try {
    const result = await run();
    console.log(`\n✓ ${name}\n  ${short(result)}`);
    return result;
  } catch (error) {
    const { kind, status } = classifyAhError(error);
    console.log(`\n✗ ${name}\n  ${kind}${status ? ` (status ${status})` : ""}: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

const auth = new AhAuth();
const tokens = await auth.anonymous();
console.log(`anonymous token: valid for ${Math.round((tokens.expiresAt - Date.now() / 1000) / 3600)} hours`);
const ah = new AhClient(tokens.accessToken);

const search = (await probe("product search", () => api.searchProducts(ah, "pindakaas", 3, "RELEVANCE"))) as api.RawSearch | undefined;
const productId = search?.products?.[0]?.webshopId ?? 220739;
await probe("products by ids", () => api.productsByIds(ah, [productId]));
await probe("product detail", () => api.productDetail(ah, productId));

const periods = (await probe("bonus periods", () => api.bonusPeriods(ah))) as api.RawBonusPeriod[] | undefined;
const period = periods?.[0];
const entry = period?.tabs?.flatMap((t) => t.urlMetadataList ?? []).find((e) => e.bonusType === "NATIONAL");
const section = (await probe("bonus section", () => api.bonusSection(ah, entry?.url ?? ""))) as api.RawBonusSection | undefined;
const group = section?.bonusGroupOrProducts?.find((e) => e.bonusGroup)?.bonusGroup;
await probe("bonus group", () => api.bonusGroup(ah, String(group?.id ?? group?.segmentId ?? ""), period?.bonusStartDate ?? "", period?.bonusEndDate ?? ""));

const recipes = (await probe("recipe search", () => api.searchRecipes(ah, "lasagne", 3))) as api.RawRecipeSearch | undefined;
const recipeId = recipes?.result?.[0]?.id ?? 0;
await probe("recipe", () => api.recipe(ah, recipeId));
await probe("recipe product suggestions", () => api.recipeSuggestions(ah, recipeId));

await probe("delivery slots", async () =>
  (await api.deliverySlots(ah, { street: "Provincialeweg", houseNumber: 11, postalCode: "1506 MA", city: "Zaandam" })).slice(0, 1),
);

// These belong to an account. Without one they show how Albert Heijn answers a visitor.
await probe("basket (visitor)", () => api.basket(ah));
await probe("active order (visitor)", () => api.hasActiveOrder(ah));
await probe("orders (visitor)", () => api.orders(ah, "OPEN"));
await probe("member (visitor)", () => api.member(ah));

await probe("token refresh", async () => {
  const next = await auth.refresh(tokens.refreshToken);
  const again = await auth.refresh(tokens.refreshToken).then(
    () => "the old refresh token still works",
    () => "the old refresh token is refused",
  );
  return { rotated: next.refreshToken !== tokens.refreshToken, afterwards: again, logout: await auth.logout(next.refreshToken) };
});
