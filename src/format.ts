import type PicnicClient from "picnic-api";

type Cart = PicnicClient.Types.cart.Cart;
type CartLineItem = PicnicClient.Types.cart.CartLineItem;
type DeliverySlot = PicnicClient.Types.cart.DeliverySlot;
type ProductTile = PicnicClient.Types.catalog.ProductTile;
type Product = PicnicClient.Types.catalog.Product;
type Delivery = PicnicClient.Types.delivery.Delivery;
type DeliverySummary = PicnicClient.Types.delivery.DeliverySummary;
type Recipe = PicnicClient.Types.recipe.Recipe;
type RecipeSummary = PicnicClient.Types.recipe.RecipeSummary;

/** Cents to a price as people write it: 249 becomes "€2.49". */
export function eur(cents: number | null | undefined): string | undefined {
  return typeof cents === "number" ? `€${(cents / 100).toFixed(2)}` : undefined;
}

/** Drops empty values (null, undefined, "", [], {}) so results stay short for the model. */
export function clean(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(clean).filter((v) => v !== undefined);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      const v = clean(raw);
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
      out[key] = v;
    }
    return out;
  }
  return value === null ? undefined : value;
}

function bulkPrices(ranges: { price: number; from_quantity: number }[] | null | undefined): string[] | undefined {
  const tiers = ranges?.filter((r) => r.from_quantity > 1);
  return tiers?.length ? tiers.map((r) => `${eur(r.price)} each from ${r.from_quantity}`) : undefined;
}

export function productTile(p: ProductTile) {
  return {
    product_id: p.id,
    name: [p.namePrefix, p.name].filter(Boolean).join(" "),
    brand: p.brand,
    size: p.unitQuantity,
    price: eur(p.displayPrice),
    was: eur(p.originalPrice),
    unit_price: p.unitPrice,
    deals: p.labels.map((l) => l.text).filter(Boolean),
    bulk_prices: bulkPrices(p.priceRanges),
    unavailable: p.isUnavailable || undefined,
  };
}

export function productDetails(p: Product, imageUrl: string | undefined) {
  return {
    product_id: p.id,
    name: p.name,
    brand: p.brand,
    size: p.unitQuantity,
    price: eur(p.displayPrice),
    was: eur(p.originalPrice),
    unit_price: p.unitPrice,
    bulk_prices: bulkPrices(p.priceRanges),
    max_quantity: p.maxCount,
    promotion: p.promotion?.label,
    labels: p.labels.map((l) => l.text),
    tags: p.tags.map((t) => t.text),
    description: p.description,
    highlights: p.highlightItems.map((h) => h.text),
    allergens: {
      contains: p.allergenGroups.contains.map((a) => a.text),
      may_contain: p.allergenGroups.mayContain.map((a) => a.text),
    },
    nutrition: p.nutritionRows.map((r) => (r.value ? `${r.label}: ${r.value}` : r.label)),
    info: p.infoSections.map((s) => ({ title: s.title, text: s.content.slice(0, 2000) })),
    similar_products: p.similarProducts.slice(0, 6).map((s) => ({
      product_id: s.id,
      name: s.name,
      size: s.unitQuantity,
      price: eur(s.displayPrice),
    })),
    image_url: imageUrl,
  };
}

function cartLine(i: CartLineItem) {
  return {
    product_id: i.productId,
    name: i.name,
    size: i.unitQuantity,
    quantity: i.quantity,
    price: eur(i.displayPrice),
    was: eur(i.originalPrice),
    deals: i.labels.map((l) => l.text).filter(Boolean),
    unavailable: i.isUnavailable || undefined,
    unavailable_reason: i.unavailableReason,
    for_recipe_id: i.recipeId,
  };
}

function window(start: string | null, end: string | null): string | undefined {
  return start && end ? `${start} – ${end}` : (start ?? undefined);
}

export function cart(c: Cart) {
  const slot = c.selectedSlot;
  return {
    items: c.items.map(cartLine),
    item_count: c.totalCount,
    total: eur(c.totalPrice),
    savings: eur(c.discount || c.promotionSavings + c.membershipSavings || null),
    deposit: eur(c.depositTotal || null),
    fees: c.fees.map((f) => ({ name: f.name, amount: eur(f.amount) })),
    minimum_order_value: eur(c.minimumOrderValue),
    below_minimum_order_value: (c.minimumOrderValue !== null && c.totalPrice < c.minimumOrderValue) || undefined,
    delivery_slot: slot && {
      slot_id: slot.slotId,
      window: window(slot.windowStart, slot.windowEnd),
      chosen_by_user: slot.isExplicitSelection,
    },
    recipes: c.recipes.map((r) => ({ recipe_id: r.id, name: r.title, portions: r.preTitle })),
  };
}

export function deliverySlot(s: DeliverySlot) {
  return {
    slot_id: s.slotId,
    start: s.windowStart,
    end: s.windowEnd,
    order_before: s.cutOffTime,
    available: s.isAvailable,
    selected: s.isSelected || undefined,
    green_choice: s.isGreenChoice || undefined,
    minimum_order_value: eur(s.minimumOrderValue),
  };
}

export function deliverySummary(d: DeliverySummary) {
  return {
    delivery_id: d.id,
    status: d.status,
    ordered_at: d.creationTime,
    window: window(d.windowStart, d.windowEnd),
    items: d.itemCount,
    total: eur(d.totalPrice),
  };
}

export function delivery(d: Delivery) {
  return {
    delivery_id: d.id,
    status: d.status,
    ordered_at: d.creationTime,
    window: window(d.windowStart, d.windowEnd),
    total: eur(d.totalPrice),
    savings: eur(d.discount || null),
    deposit: eur(d.depositTotal || null),
    can_be_cancelled_in_app: d.cancellable || undefined,
    items: d.orders.flatMap((o) => o.items.map(cartLine)),
    returned_containers: d.returnedContainers.map((r) => ({ name: r.name, quantity: r.quantity, refund: eur(r.price) })),
  };
}

export function recipeSummary(r: RecipeSummary | PicnicClient.Types.catalog.SearchRecipe) {
  return {
    recipe_id: r.id,
    name: r.name,
    subtitle: r.subtitle,
    tags: r.tags,
    cooking_minutes: r.cookingTimeMinutes,
  };
}

export function recipe(r: Recipe) {
  return {
    recipe_id: r.id,
    name: r.name,
    kind: r.creatorType === "USER" ? "own" : "picnic",
    saved: r.isSaved || undefined,
    portions: r.portions,
    description: r.description,
    times: r.times.map((t) => `${t.label}: ${t.value}`),
    ingredients: r.ingredients.map((i) => ({
      ingredient_id: i.ingredientId,
      product_id: i.sellingUnitId,
      name: i.name,
      brand: i.brand,
      size: i.unitQuantity,
      quantity: i.quantity,
      needed: i.neededText,
      price: eur(i.price),
      added_by_default: i.checked,
      pantry_item: i.type === "CUPBOARD" || undefined,
      unavailable: !i.isAvailable || undefined,
      unavailable_reason: i.unavailableReason,
    })),
    steps: r.steps,
    steps_note: r.stepsWarning,
    note: r.note,
    nutrition_per_portion: r.nutritionRows.map((n) => (n.value ? `${n.label}: ${n.value}` : n.label)),
    allergens: { contains: r.allergens.contains, may_contain: r.allergens.mayContain },
  };
}
