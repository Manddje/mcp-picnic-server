import { AhApiError, type AhClient } from "./client.js";

/**
 * The calls the tools make, with the answers as Albert Heijn gives them. Every field is optional
 * on purpose: this is an undocumented API, so nothing in an answer can be counted on.
 */

/* ---------- Products ---------- */

export type RawDiscountLabel = { defaultDescription?: string };

/** A product as the REST search and the products-by-ids call return it. Prices are in euros. */
export type RawProduct = {
  webshopId?: number;
  title?: string;
  brand?: string;
  salesUnitSize?: string;
  unitPriceDescription?: string | null;
  priceBeforeBonus?: number | null;
  currentPrice?: number | null;
  isBonus?: boolean;
  bonusMechanism?: string | null;
  bonusEndDate?: string;
  promotionType?: string;
  discountLabels?: RawDiscountLabel[];
  mainCategory?: string;
  subCategory?: string;
  nutriscore?: string | null;
  isOrderable?: boolean;
  availableOnline?: boolean;
  isPreviouslyBought?: boolean;
  nix18?: boolean;
  isSponsored?: boolean;
};

export type ProductSort = "RELEVANCE" | "PRICELOWHIGH" | "PRICEHIGHLOW";

export type RawSearch = { page?: { totalElements?: number }; products?: RawProduct[] };

export async function searchProducts(ah: AhClient, query: string, size: number, sortOn: ProductSort): Promise<RawSearch> {
  return (await ah.rest<RawSearch>("/mobile-services/product/search/v2", { query: { query, page: 0, size, sortOn } })) ?? {};
}

/** Products by id, in the order asked for. This call carries the current price and bonus. */
export async function productsByIds(ah: AhClient, ids: number[]): Promise<RawProduct[]> {
  if (ids.length === 0) return [];
  const result = await ah.rest<RawProduct[]>("/mobile-services/product/search/v2/products", {
    query: { ids: [...new Set(ids)].slice(0, 100), sortOn: "INPUT_PRODUCT_IDS" },
  });
  return Array.isArray(result) ? result : [];
}

export type RawProductDetail = {
  id?: number;
  title?: string;
  brand?: string;
  salesUnitSize?: string;
  summary?: string | null;
  category?: string | null;
  icons?: string[] | null;
  highlights?: string[] | null;
  additionalInformation?: string | null;
  properties?: { code?: string; values?: string[] | null }[] | null;
  priceV2?: RawPrice | null;
  availability?: { isOrderable?: boolean } | null;
  tradeItem?: {
    gtin?: string | null;
    ingredients?: {
      statement?: string | null;
      allergens?: { contains?: string[] | null; mayContain?: string[] | null; freeFrom?: string[] | null } | null;
    } | null;
    nutritions?: { basisQuantity?: string | null; nutrients?: { name?: string; value?: string | null }[] | null }[] | null;
  } | null;
};

export type RawPrice = {
  now?: { amount?: number } | null;
  was?: { amount?: number } | null;
  promotionLabel?: { tiers?: { description?: string }[] | null } | null;
};

const PRICE = "priceV2 { now { amount } was { amount } promotionLabel { tiers { description } } }";

const PRODUCT = `query Product($id: Int!) { product(id: $id) {
  id title brand salesUnitSize summary category icons highlights additionalInformation
  properties { code values }
  ${PRICE}
  availability { isOrderable }
  tradeItem {
    gtin
    ingredients { statement allergens { contains mayContain freeFrom } }
    nutritions { basisQuantity nutrients { name value } }
  }
} }`;

export async function productDetail(ah: AhClient, id: number): Promise<RawProductDetail | null> {
  // Parts of the label are missing for many products; what did come is still worth showing.
  return (await ah.graphql<{ product?: RawProductDetail | null }>(PRODUCT, { id }, { partial: true })).product ?? null;
}

/* ---------- Bonus ---------- */

export type RawBonusEntry = { url?: string; bonusType?: string; description?: string; count?: number };

export type RawBonusPeriod = {
  bonusStartDate?: string;
  bonusEndDate?: string;
  tabs?: { urlMetadataList?: RawBonusEntry[] }[];
};

export type RawBonusGroup = {
  id?: string;
  segmentId?: number;
  segmentDescription?: string;
  discountDescription?: string;
  discountLabels?: RawDiscountLabel[];
  category?: string;
  bonusEndDate?: string;
  extraDescriptions?: string[];
  exceptionRule?: string;
  storeOnlyPromotion?: boolean;
  activationStatus?: string;
};

export type RawBonusSection = {
  sectionDescription?: string;
  bonusGroupOrProducts?: { bonusGroup?: RawBonusGroup; product?: RawProduct }[];
};

export async function bonusPeriods(ah: AhClient): Promise<RawBonusPeriod[]> {
  return (await ah.rest<{ periods?: RawBonusPeriod[] }>("/mobile-services/bonuspage/v3/metadata"))?.periods ?? [];
}

/** One section of the bonus page. `url` comes from {@link bonusPeriods} and is only used as a path under /mobile-services. */
export async function bonusSection(ah: AhClient, url: string): Promise<RawBonusSection> {
  const path = url.replace(/^\/+/, "");
  if (!path.startsWith("bonuspage/") || path.includes("..")) throw new AhApiError("changed", "Albert Heijn's bonus page moved");
  return (await ah.rest<RawBonusSection>(`/mobile-services/${path}`)) ?? {};
}

/** The member's own offers for the bonus week that starts on `monday` (YYYY-MM-DD). */
export async function personalBonus(ah: AhClient, monday: string): Promise<RawBonusSection[]> {
  const raw = await ah.rest<RawBonusSection | RawBonusSection[]>("/mobile-services/bonuspage/v1/personal", { query: { bonusStartDate: monday } });
  return raw ? (Array.isArray(raw) ? raw : [raw]) : [];
}

export type RawPromotion = {
  id?: string;
  title?: string;
  products?: { id?: number; title?: string; brand?: string; salesUnitSize?: string; availability?: { isOrderable?: boolean } | null; priceV2?: RawPrice | null }[];
};

const PROMOTION = `query FetchBonusPromotionWithProducts($id: String, $periodStart: String, $periodEnd: String) {
  bonusPromotions(input: { id: $id, periodStart: $periodStart, periodEnd: $periodEnd,
      filterUnavailableProducts: true, forcePromotionVisibility: true, showAllPromotionSegments: true }) {
    id title
    products {
      id title brand salesUnitSize availability { isOrderable }
      priceV2(periodStart: $periodStart, periodEnd: $periodEnd, filterUnavailableProducts: true, forcePromotionVisibility: true) {
        now { amount } was { amount } promotionLabel { tiers { description } }
      }
    }
  }
}`;

/** The products of one bonus group, for the bonus week from `periodStart` to `periodEnd`. */
export async function bonusGroup(ah: AhClient, id: string, periodStart: string, periodEnd: string): Promise<RawPromotion | null> {
  const data = await ah.graphql<{ bonusPromotions?: RawPromotion[] | null }>(PROMOTION, { id, periodStart, periodEnd });
  return data.bonusPromotions?.[0] ?? null;
}

/* ---------- Recipes ---------- */

export type RawRecipeSummary = {
  id?: number;
  title?: string;
  time?: { cook?: number } | null;
  tags?: { value?: string }[] | null;
};

const RECIPES = `query FetchRecipes($searchText: String, $start: Int, $size: PageSize, $sortBy: RecipeSearchSortOption, $recipeIds: [Int!]!) {
  recipeSearchV2(searchText: $searchText, start: $start, size: $size, sortBy: $sortBy, recipeIds: $recipeIds) {
    correctedSearchTerm
    page { total }
    result { id title time { cook } tags { key value } }
  }
}`;

export type RawRecipeSearch = { correctedSearchTerm?: string | null; page?: { total?: number } | null; result?: RawRecipeSummary[] | null };

export async function searchRecipes(ah: AhClient, searchText: string, size: number): Promise<RawRecipeSearch> {
  const data = await ah.graphql<{ recipeSearchV2?: RawRecipeSearch | null }>(RECIPES, { searchText, start: 0, size, sortBy: "MOST_RELEVANT", recipeIds: [] });
  return data.recipeSearchV2 ?? {};
}

export type RawRecipe = {
  id?: number;
  title?: string;
  description?: string | null;
  cookTime?: number | null;
  ovenTime?: number | null;
  waitTime?: number | null;
  servings?: { number?: number; type?: string } | null;
  ingredients?: {
    id?: number;
    text?: string | null;
    quantity?: number | null;
    quantityUnit?: { singular?: string | null; plural?: string | null } | null;
    name?: { singular?: string | null; plural?: string | null } | null;
  }[];
  preparation?: { steps?: string[] | null } | null;
  nutritions?: Record<string, { value?: number; unit?: string } | null> | null;
};

const RECIPE = `query Recipe($id: Int!) { recipe(id: $id) {
  id title description cookTime ovenTime waitTime
  servings { number type }
  ingredients { id text quantity quantityUnit { singular plural } name { singular plural } }
  preparation { steps }
  nutritions { energy { value unit } protein { value unit } fat { value unit } carbohydrates { value unit } }
} }`;

export async function recipe(ah: AhClient, id: number): Promise<RawRecipe | null> {
  // Some recipes lack part of the nutrition block, which Albert Heijn reports as an error next to the recipe.
  return (await ah.graphql<{ recipe?: RawRecipe | null }>(RECIPE, { id }, { partial: true })).recipe ?? null;
}

export type RawSuggestion = {
  optional?: boolean | null;
  ingredient?: { id?: number } | null;
  productSuggestion?: { quantity?: number | null; product?: RawBasketProduct | null } | null;
};

const SUGGESTIONS = `query Suggestions($id: Int!) { recipeProductSuggestionsV2(options: { recipeId: $id }) {
  optional
  ingredient { id }
  productSuggestion { quantity product { id title salesUnitSize priceV2 { now { amount } was { amount } } } }
} }`;

/** The product Albert Heijn suggests for each ingredient of a recipe, at the recipe's own number of servings. */
export async function recipeSuggestions(ah: AhClient, id: number): Promise<RawSuggestion[]> {
  return (await ah.graphql<{ recipeProductSuggestionsV2?: RawSuggestion[] | null }>(SUGGESTIONS, { id }, { partial: true })).recipeProductSuggestionsV2 ?? [];
}

/* ---------- Basket ---------- */

export type RawBasketProduct = { id?: number; title?: string; salesUnitSize?: string; priceV2?: RawPrice | null };

export type RawBasketItem = { quantity?: number; isStrikethrough?: boolean; product?: RawBasketProduct | null };

/**
 * In the Albert Heijn app the shopping list and the online order share one basket. Without a
 * booked delivery the basket is the list (`itemsInList`). Once a delivery or pick-up is booked,
 * what is added goes into that real order (`itemsInOrder`).
 */
export type RawBasket = {
  itemsInList?: RawBasketItem[] | null;
  itemsInOrder?: RawBasketItem[] | null;
  notes?: { description?: string; quantity?: number }[] | null;
  summary?: {
    shoppingType?: string | null;
    deliveryDate?: string | null;
    price?: { totalPrice?: { amount?: number } | null; discount?: { amount?: number } | null } | null;
  } | null;
};

const BASKET_PRODUCT = "product { id title salesUnitSize priceV2 { now { amount } was { amount } } }";
const BASKET_FIELDS = `id
  itemsInList { id quantity isStrikethrough ${BASKET_PRODUCT} }
  itemsInOrder { id quantity ${BASKET_PRODUCT} }
  notes { description quantity }
  summary { quantity shoppingType deliveryDate price { totalPrice { amount } discount { amount } } }`;

export async function basket(ah: AhClient): Promise<RawBasket> {
  const data = await ah.graphql<{ basket?: RawBasket | null }>(`query Basket { basket { ${BASKET_FIELDS} } }`);
  if (!data.basket) throw new AhApiError("changed", "Albert Heijn answered without a basket");
  return data.basket;
}

export type BasketChange = { id: number; quantity: number };

type MutationResult = { status?: string | null; errorMessage?: string | null; result?: RawBasket | null };

function changed(result: MutationResult | null | undefined): RawBasket | null {
  if (!result) throw new AhApiError("other", "Albert Heijn did not confirm the change. Look at the basket before trying again.");
  if (result.status && result.status !== "SUCCESS") {
    throw new AhApiError("other", `Albert Heijn refused the change: ${(result.errorMessage ?? result.status).slice(0, 200)}`);
  }
  return result.result ?? null;
}

/** Adds quantities to what is in the basket. Returns the basket afterwards when Albert Heijn sends it. */
export async function basketAdd(ah: AhClient, items: BasketChange[]): Promise<RawBasket | null> {
  const data = await ah.graphql<{ basketItemsAdd?: MutationResult | null }>(
    `mutation BasketItemsAdd($items: [BasketMutation!]!) { basketItemsAdd(items: $items) { status errorMessage result { ${BASKET_FIELDS} } } }`,
    { items },
  );
  return changed(data.basketItemsAdd);
}

/** Sets quantities in the basket; 0 removes a product. Returns the basket afterwards when Albert Heijn sends it. */
export async function basketUpdate(ah: AhClient, items: BasketChange[]): Promise<RawBasket | null> {
  const data = await ah.graphql<{ basketItemsUpdate?: MutationResult | null }>(
    `mutation BasketItemsUpdate($items: [BasketMutation!]!) { basketItemsUpdate(items: $items) { status errorMessage result { ${BASKET_FIELDS} } } }`,
    { items },
  );
  return changed(data.basketItemsUpdate);
}

/** Whether a delivery or pick-up is booked according to the order summary. Albert Heijn answers 404 or nothing when there is none. */
export async function hasActiveOrder(ah: AhClient): Promise<boolean> {
  const summary = await ah.rest<{ id?: number }>("/mobile-services/order/v1/summaries/active", { query: { sortBy: "DEFAULT" }, allow404: true });
  return Boolean(summary?.id);
}

/* ---------- Delivery, orders, account ---------- */

export type SlotAddress = { street: string; houseNumber: number; houseNumberExtra?: string; postalCode: string; city: string };

export type RawSlotDay = {
  date?: string;
  dateFormatted?: string;
  isFullyBooked?: boolean;
  slots?: {
    startTime?: string;
    endTime?: string;
    isFullyBooked?: boolean;
    serviceCharge?: { price?: { amount?: number } | null; defaultPrice?: { amount?: number } | null } | null;
  }[];
};

const SLOTS = `query Slots($address: MemberAddressInput!) {
  orderDeliverySlots(address: $address) {
    date dateFormatted isFullyBooked
    slots { startTime endTime isFullyBooked serviceCharge { price { amount } defaultPrice { amount } } }
  }
}`;

/** The home delivery windows for an address, with what each costs. Booking one is done in the app. */
export async function deliverySlots(ah: AhClient, a: SlotAddress): Promise<RawSlotDay[]> {
  const address = {
    street: a.street,
    houseNumber: a.houseNumber,
    postalCode: a.postalCode.replace(/\s+/g, "").toUpperCase(),
    city: a.city,
    countryCode: "NLD",
    ...(a.houseNumberExtra ? { houseNumberExtra: a.houseNumberExtra } : {}),
  };
  return (await ah.graphql<{ orderDeliverySlots?: RawSlotDay[] | null }>(SLOTS, { address })).orderDeliverySlots ?? [];
}

export type RawOrder = {
  orderId?: number;
  statusDescription?: string;
  shoppingType?: string;
  totalPrice?: { totalPrice?: { amount?: number } | null } | null;
  delivery?: { status?: string; slot?: { date?: string; timeDisplay?: string } | null } | null;
};

export async function orders(ah: AhClient, status: "OPEN" | "CLOSED"): Promise<RawOrder[]> {
  const data = await ah.graphql<{ orderFulfillments?: { result?: RawOrder[] | null } | null }>(
    `query Orders { orderFulfillments(status: ${status}) { result {
      orderId statusDescription shoppingType
      totalPrice { totalPrice { amount } }
      delivery { status slot { date timeDisplay } }
    } } }`,
    {},
    { partial: true },
  );
  return data.orderFulfillments?.result ?? [];
}

export type RawMember = {
  emailAddress?: string;
  name?: { first?: string; last?: string } | null;
  address?: { street?: string; houseNumber?: number | string; houseNumberExtra?: string | null; postalCode?: string; city?: string } | null;
  cards?: { bonus?: string | null } | null;
};

const MEMBER = `query FetchMember { member {
  id emailAddress
  name { first last }
  address { street houseNumber houseNumberExtra postalCode city }
  cards { bonus }
} }`;

export async function member(ah: AhClient): Promise<RawMember> {
  const data = await ah.graphql<{ member?: RawMember | null }>(MEMBER, {}, { partial: true });
  if (!data.member) throw new AhApiError("changed", "Albert Heijn answered without a profile");
  return data.member;
}
