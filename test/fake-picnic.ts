import PicnicClient from "picnic-api";
import type { PicnicFactory } from "../src/picnic.js";

type Cart = PicnicClient.Types.cart.Cart;
type ProductTile = PicnicClient.Types.catalog.ProductTile;

const apiError = (status: number, code?: string) =>
  new PicnicClient.PicnicApiError(status, "Error", code ? JSON.stringify({ error: { code, message: code } }) : "<html>blocked</html>");

const CATALOG: Record<string, { name: string; price: number; size: string }> = {
  s100: { name: "Halfvolle melk", price: 129, size: "1 liter" },
  s200: { name: "Penne", price: 99, size: "500 gram" },
};

function tile(id: string): ProductTile {
  const p = CATALOG[id]!;
  return {
    id,
    name: p.name,
    namePrefix: null,
    brand: "Picnic",
    qualityCue: null,
    imageId: "img",
    displayPrice: p.price,
    originalPrice: null,
    unitPrice: null,
    comparisonPrice: null,
    priceRanges: null,
    unitQuantity: p.size,
    labels: [],
    isUnavailable: false,
    numberOfOrders: null,
  };
}

/** An in-memory stand-in for Picnic: one password, an SMS code, and a cart per signed-in key. */
export class FakePicnic {
  static readonly PASSWORD = "correct-horse";
  static readonly SMS_CODE = "123456";

  smsSent = 0;
  throttle = false;
  /** Picnic can't be reached to sign out. */
  down = false;
  readonly deviceIds = new Set<string>();
  readonly signedOut = new Set<string>();
  private readonly carts = new Map<string, Map<string, number>>();
  private keys = 0;

  readonly factory: PicnicFactory = ({ deviceId, authKey }) => {
    this.deviceIds.add(deviceId);
    let key = authKey ?? null;
    const authed = () => {
      if (!key || !key.startsWith("key-") || this.signedOut.has(key)) throw apiError(401, "AUTH_ERROR");
      return key;
    };
    const cartOf = (): Cart => {
      const lines = this.carts.get(authed()) ?? new Map<string, number>();
      const items = [...lines].map(([id, quantity]) => ({
        id: `line-${id}`,
        productId: id,
        name: CATALOG[id]!.name,
        unitQuantity: CATALOG[id]!.size,
        imageId: null,
        quantity,
        maxCount: 99,
        displayPrice: CATALOG[id]!.price * quantity,
        originalPrice: null,
        priceColor: null,
        priceRanges: null,
        labels: [],
        basePrice: null,
        comparisonPrice: null,
        freshness: null,
        characteristics: [],
        isUnavailable: false,
        unavailableReason: null,
        replacements: [],
        bundlesLink: null,
        recipeId: null,
      }));
      return {
        id: "cart",
        mts: 1,
        items,
        totalCount: items.reduce((n, i) => n + i.quantity, 0),
        totalPrice: items.reduce((n, i) => n + i.displayPrice, 0),
        discount: 0,
        promotionSavings: 0,
        membershipSavings: 0,
        deposits: [],
        depositTotal: 0,
        fees: [],
        minimumOrderValue: 4000,
        selectedSlot: null,
        recipes: [],
      };
    };
    const change = (id: string, delta: number): Cart => {
      const k = authed();
      if (!CATALOG[id]) throw new PicnicClient.ProductNotFoundError(id);
      const lines = this.carts.get(k) ?? new Map<string, number>();
      const next = (lines.get(id) ?? 0) + delta;
      if (next > 0) lines.set(id, next);
      else lines.delete(id);
      this.carts.set(k, lines);
      return cartOf();
    };

    const client = {
      auth: {
        login: async (email: string, password: string) => {
          if (this.throttle) throw apiError(403);
          if (password !== FakePicnic.PASSWORD) throw apiError(401, "AUTH_INVALID_CRED");
          const twoFactor = !email.startsWith("no2fa");
          key = twoFactor ? `pre-${++this.keys}` : `key-${++this.keys}`;
          return { authKey: key, userId: "u1", secondFactorAuthenticationRequired: twoFactor, showSecondFactorAuthenticationIntro: false };
        },
        generate2FACode: async () => {
          if (!key?.startsWith("pre-")) throw apiError(401, "AUTH_ERROR");
          this.smsSent++;
          return null;
        },
        verify2FACode: async (code: string) => {
          if (!key?.startsWith("pre-")) throw apiError(401, "AUTH_ERROR");
          if (code !== FakePicnic.SMS_CODE) throw apiError(400, "OTP_NOT_VALID");
          key = `key-${++this.keys}`;
          return { authKey: key };
        },
        logout: async () => {
          if (this.down) throw apiError(503);
          this.signedOut.add(authed());
          return null;
        },
      },
      cart: {
        getCart: async () => cartOf(),
        addProductToCart: async (id: string, count = 1) => change(id, count),
        removeProductFromCart: async (id: string, count = 1) => change(id, -count),
        clearCart: async () => {
          this.carts.delete(authed());
          return cartOf();
        },
      },
      catalog: {
        getSearchResults: async (query: string) => {
          authed();
          const hits = Object.keys(CATALOG).filter((id) => CATALOG[id]!.name.toLowerCase().includes(query.toLowerCase()));
          return {
            query,
            correctedQuery: null,
            products: {
              sections: [
                { id: "again", type: "RFY", title: "Opnieuw bestellen", products: hits.slice(0, 1).map(tile) },
                { id: "all", type: "VISUAL", title: null, products: hits.map(tile) },
              ],
              visualFilters: [],
              powerFilters: [],
              textualFilters: [],
              productIdsByFacetId: {},
              sortingOptions: [],
              selectedSorting: "RELEVANCE",
            },
            recipes: [],
          };
        },
      },
    };
    return client as unknown as PicnicClient;
  };
}
