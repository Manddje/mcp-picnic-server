import type * as api from "./api.js";

/** Euros to a price as people write it: 2.49 becomes "€2.49". */
export function eur(amount: number | null | undefined): string | undefined {
  return typeof amount === "number" && Number.isFinite(amount) ? `€${amount.toFixed(2)}` : undefined;
}

const AMSTERDAM = "Europe/Amsterdam";
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: AMSTERDAM });
const timeFormat = new Intl.DateTimeFormat("nl-NL", { timeZone: AMSTERDAM, hour: "2-digit", minute: "2-digit", hour12: false });

/** Today's date in the Netherlands, as YYYY-MM-DD. */
export function today(): string {
  return dayFormat.format(new Date());
}

/** A moment as the time of day in the Netherlands: "16:00". */
function time(iso: string | undefined): string | undefined {
  const date = iso ? new Date(iso) : null;
  return date && !Number.isNaN(date.getTime()) ? timeFormat.format(date) : undefined;
}

function isOrderable(p: api.RawProduct): boolean {
  return p.isOrderable ?? p.availableOnline ?? true;
}

/** A product from the search, the products-by-ids call or the bonus page. */
export function product(p: api.RawProduct) {
  const regular = p.priceBeforeBonus ?? null;
  const now = p.currentPrice ?? regular;
  return {
    product_id: p.webshopId,
    name: p.title,
    brand: p.brand,
    size: p.salesUnitSize,
    price: eur(now),
    was: now !== null && regular !== null && now !== regular ? eur(regular) : undefined,
    unit_price: p.unitPriceDescription,
    deal: p.isBonus ? (p.bonusMechanism ?? p.discountLabels?.[0]?.defaultDescription) : undefined,
    // Albert Heijn marks a deal without an end with the year 2999.
    deal_until: p.isBonus && p.bonusEndDate && !p.bonusEndDate.startsWith("2999") ? p.bonusEndDate : undefined,
    online_only_deal: (p.isBonus && p.promotionType === "AHONLINE") || undefined,
    category: [p.mainCategory, p.subCategory].filter(Boolean).join(" / "),
    nutriscore: p.nutriscore,
    bought_before: p.isPreviouslyBought || undefined,
    age_check: p.nix18 || undefined,
    unavailable: !isOrderable(p) || undefined,
  };
}

function deal(price: api.RawPrice | null | undefined): string | undefined {
  return price?.promotionLabel?.tiers
    ?.map((t) => t.description)
    .filter(Boolean)
    .join(", ");
}

const DIET_PREFIXES = ["sp_include_dieet_", "sp_include_intolerance_"];

/** A product with everything on its label. `live` is the same product from the products-by-ids call, which knows the bonus. */
export function productDetails(d: api.RawProductDetail, live: api.RawProduct | undefined) {
  const properties = d.properties ?? [];
  const now = d.priceV2?.now?.amount;
  const was = d.priceV2?.was?.amount;
  const nutrition = d.tradeItem?.nutritions?.[0];
  return {
    ...(live
      ? product(live)
      : {
          product_id: d.id,
          name: d.title,
          brand: d.brand,
          size: d.salesUnitSize,
          price: eur(now),
          was: now !== undefined && was !== undefined && was !== now ? eur(was) : undefined,
          deal: deal(d.priceV2),
          unavailable: d.availability?.isOrderable === false || undefined,
        }),
    category: d.category,
    nutriscore: properties.find((p) => p.code === "nutriscore")?.values?.[0] ?? live?.nutriscore,
    description: d.summary,
    highlights: d.highlights,
    diet_labels: properties.filter((p) => DIET_PREFIXES.some((prefix) => p.code?.startsWith(prefix))).flatMap((p) => p.values ?? []),
    ingredients: d.tradeItem?.ingredients?.statement,
    allergens: {
      contains: d.tradeItem?.ingredients?.allergens?.contains,
      may_contain: d.tradeItem?.ingredients?.allergens?.mayContain,
    },
    nutrition_per: nutrition?.basisQuantity,
    nutrition: nutrition?.nutrients?.filter((n) => n.name && n.value).map((n) => `${n.name}: ${n.value}`),
    more_info: d.additionalInformation?.slice(0, 1500),
    barcode: d.tradeItem?.gtin,
  };
}

/** One entry of the bonus page: a single product, or a group such as “all AH quiches, 1 + 1 free”. */
export function bonusOffer(entry: { bonusGroup?: api.RawBonusGroup; product?: api.RawProduct }, section: string | undefined) {
  const g = entry.bonusGroup;
  if (g) {
    return {
      group_id: g.id ?? (g.segmentId !== undefined ? String(g.segmentId) : undefined),
      name: g.segmentDescription,
      deal: g.discountDescription ?? g.discountLabels?.[0]?.defaultDescription,
      category: g.category ?? section,
      until: g.bonusEndDate,
      conditions: [...(g.extraDescriptions ?? []), ...(g.exceptionRule ? [g.exceptionRule] : [])],
      in_store_only: g.storeOnlyPromotion || undefined,
      activation: g.activationStatus,
    };
  }
  return entry.product ? { ...product(entry.product), category: entry.product.mainCategory ?? section } : undefined;
}

export function promotion(p: api.RawPromotion) {
  return {
    group_id: p.id,
    name: p.title,
    products: (p.products ?? []).map((item) => {
      const now = item.priceV2?.now?.amount;
      const was = item.priceV2?.was?.amount;
      return {
        product_id: item.id,
        name: item.title,
        brand: item.brand,
        size: item.salesUnitSize,
        price: eur(now),
        was: now !== undefined && was !== undefined && was !== now ? eur(was) : undefined,
        deal: deal(item.priceV2),
        unavailable: item.availability?.isOrderable === false || undefined,
      };
    }),
  };
}

export function recipeSummary(r: api.RawRecipeSummary) {
  return {
    recipe_id: r.id,
    name: r.title,
    cooking_minutes: r.time?.cook,
    tags: r.tags?.map((t) => t.value).filter(Boolean),
  };
}

function amount(value: number): number {
  return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
}

/** A recipe, scaled to `portions` when asked. Albert Heijn's product suggestions are for the recipe's own number of portions. */
export function recipe(r: api.RawRecipe, suggestions: api.RawSuggestion[], portions: number | undefined) {
  const own = r.servings?.number && r.servings.number > 0 ? r.servings.number : 4;
  const factor = (portions ?? own) / own;
  const byIngredient = new Map(suggestions.filter((s) => s.ingredient?.id !== undefined).map((s) => [s.ingredient!.id!, s]));
  const nutrition = Object.entries(r.nutritions ?? {})
    .filter(([, n]) => typeof n?.value === "number")
    .map(([name, n]) => `${name}: ${n!.value} ${n!.unit ?? ""}`.trim());
  return {
    recipe_id: r.id,
    name: r.title,
    description: r.description?.trim(),
    portions: portions ?? own,
    recipe_portions: own,
    minutes: { cooking: r.cookTime, oven: r.ovenTime, waiting: r.waitTime },
    ingredients: (r.ingredients ?? []).map((i) => {
      const quantity = i.quantity && i.quantity > 0 ? amount(i.quantity * factor) : undefined;
      const plural = quantity !== undefined && quantity > 1;
      const unit = plural ? (i.quantityUnit?.plural ?? i.quantityUnit?.singular) : i.quantityUnit?.singular;
      const name = (plural ? i.name?.plural : null) ?? i.name?.singular ?? i.text ?? "";
      const suggestion = i.id !== undefined ? byIngredient.get(i.id) : undefined;
      const p = suggestion?.productSuggestion?.product;
      return {
        needed: quantity !== undefined ? [quantity, unit, name].filter(Boolean).join(" ") : (i.text ?? name),
        optional: suggestion?.optional || undefined,
        product: p && {
          product_id: p.id,
          name: p.title,
          size: p.salesUnitSize,
          price: eur(p.priceV2?.now?.amount),
          quantity: suggestion?.productSuggestion?.quantity ?? 1,
        },
      };
    }),
    product_quantities_are_for_portions: factor === 1 ? undefined : own,
    steps: r.preparation?.steps,
    nutrition_per_portion: nutrition,
  };
}

/** Whether a delivery or pick-up is booked, going by the basket. Changes to the basket then change that order. */
export function orderBooked(b: api.RawBasket): boolean {
  return Boolean(b.itemsInOrder?.length || b.summary?.shoppingType || b.summary?.deliveryDate);
}

function basketLine(i: api.RawBasketItem) {
  const price = i.product?.priceV2?.now?.amount;
  const quantity = i.quantity ?? 1;
  return {
    product_id: i.product?.id,
    name: i.product?.title,
    size: i.product?.salesUnitSize,
    quantity,
    price: eur(price),
    line_total: price !== undefined ? eur(price * quantity) : undefined,
    checked_off: i.isStrikethrough || undefined,
  };
}

/** How many of each product are in a list of basket items. */
export function quantities(items: api.RawBasketItem[] | null | undefined): Map<number, number> {
  const counts = new Map<number, number>();
  for (const item of items ?? []) {
    if (item.product?.id !== undefined) counts.set(item.product.id, (counts.get(item.product.id) ?? 0) + (item.quantity ?? 0));
  }
  return counts;
}

export function basket(b: api.RawBasket) {
  const items = (b.itemsInList ?? []).filter((i) => i.product?.id !== undefined).map(basketLine);
  const inOrder = (b.itemsInOrder ?? []).filter((i) => i.product?.id !== undefined).map(basketLine);
  const booked = orderBooked(b);
  const sum = (b.itemsInList ?? []).reduce((total, i) => total + (i.product?.priceV2?.now?.amount ?? 0) * (i.quantity ?? 1), 0);
  return {
    items,
    item_count: items.reduce((n, i) => n + i.quantity, 0),
    // Before bonus deals that need more than one package; the Albert Heijn app shows the final amount.
    estimated_total: items.length ? eur(sum) : undefined,
    notes: (b.notes ?? []).map((n) => n.description).filter(Boolean),
    delivery_booked: booked || undefined,
    booked_order: booked
      ? {
          delivery_date: b.summary?.deliveryDate,
          kind: b.summary?.shoppingType,
          items: inOrder,
          total: eur(b.summary?.price?.totalPrice?.amount),
          note: "A delivery or pick-up is booked, so the basket is now a real order. These tools don't change it; the user does that in the Albert Heijn app.",
        }
      : undefined,
  };
}

export function slotDay(day: api.RawSlotDay, includeFull: boolean) {
  return {
    date: day.dateFormatted ?? day.date?.slice(0, 10),
    slots: (day.slots ?? [])
      .filter((s) => includeFull || !s.isFullyBooked)
      .map((s) => {
        const price = s.serviceCharge?.price?.amount;
        const regular = s.serviceCharge?.defaultPrice?.amount;
        return {
          from: time(s.startTime),
          until: time(s.endTime),
          delivery_costs: eur(price),
          regular_costs: regular !== undefined && regular !== price ? eur(regular) : undefined,
          full: s.isFullyBooked || undefined,
        };
      }),
  };
}

export function order(o: api.RawOrder) {
  return {
    order_id: o.orderId,
    status: o.statusDescription ?? o.delivery?.status,
    kind: o.shoppingType,
    date: o.delivery?.slot?.date,
    time: o.delivery?.slot?.timeDisplay,
    total: eur(o.totalPrice?.totalPrice?.amount),
  };
}

export function address(a: api.RawMember["address"]): string | undefined {
  if (!a?.street) return undefined;
  return `${a.street} ${a.houseNumber ?? ""}${a.houseNumberExtra ?? ""}, ${a.postalCode ?? ""} ${a.city ?? ""}`.replace(/\s+/g, " ").trim();
}

/** A card number with only its last four digits readable. */
export function masked(value: string | null | undefined): string | undefined {
  return value ? `${"•".repeat(Math.max(value.length - 4, 0))}${value.slice(-4)}` : undefined;
}
