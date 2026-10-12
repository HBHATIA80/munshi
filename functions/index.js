
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();

const db = getFirestore();

const n = value =>
  Number.isFinite(Number(value)) ? Number(value) : 0;

const lines = doc =>
  Array.isArray(doc.lines)
    ? doc.lines
    : (Array.isArray(doc.items) ? doc.items : []);

const byItem = (documents, itemId, calculate) => {
  let total = 0;

  for (const doc of documents) {
    for (const line of lines(doc)) {
      if (line.itemId === itemId) {
        total += calculate(doc, line);
      }
    }
  }

  return total;
};

async function docs(collection) {
  const snapshot = await db.collection(collection).get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

/**
 * Secure inventory endpoint for Munshi company accounts.
 *
 * Company users:
 * - Can access only their assigned brands.
 * - Can see item names, SKU, quantity, categories,
 *   average purchase cost and stock valuation.
 * - Cannot receive selling prices, profit figures,
 *   sales documents or purchase document details.
 *
 * IMPORTANT:
 * Firestore Security Rules must deny company users
 * direct access to the underlying inventory collections.
 */
exports.getCompanyInventory = onCall(
  {
    region: 'us-central1',
    maxInstances: 20
  },
  async request => {
    // 1. Require Firebase Authentication.
    if (!request.auth) {
      throw new HttpsError(
        'unauthenticated',
        'Sign in is required.'
      );
    }

    const uid = request.auth.uid;

    // 2. Load the caller's current user profile.
    const userSnap = await db
      .collection('users')
      .doc(uid)
      .get();

    if (!userSnap.exists) {
      throw new HttpsError(
        'permission-denied',
        'Account profile is missing.'
      );
    }

    const user = userSnap.data();

    // 3. Only active company accounts can call this function.
    if (
      user.role !== 'company' ||
      user.active === false
    ) {
      throw new HttpsError(
        'permission-denied',
        'Company account access is required.'
      );
    }

    // 4. Get assigned brand IDs from the trusted user profile.
    const brandIds = [
      ...new Set(
        (
          Array.isArray(user.brandIds)
            ? user.brandIds
            : []
        ).filter(
          id => typeof id === 'string' && id.length > 0
        )
      )
    ];

    // No assigned brands means no inventory access.
    if (brandIds.length === 0) {
      return {
        items: [],
        brands: [],
        categories: [],
        generatedAt: Date.now()
      };
    }

    // 5. Read source data with the Admin SDK.
    // Admin SDK access bypasses Firestore Security Rules.
    const [
      allItems,
      allCategories,
      allBrands,
      purchases,
      sales,
      purchaseReturns,
      saleReturns,
      adjustments
    ] = await Promise.all([
      docs('items'),
      docs('categories'),
      docs('brands'),
      docs('purchases'),
      docs('sales'),
      docs('purchaseReturns'),
      docs('saleReturns'),
      docs('stockAdj')
    ]);

    // 6. Restrict items to the caller's assigned brands.
    const allowedBrands = new Set(brandIds);

    const items = allItems.filter(
      item => allowedBrands.has(item.brandId)
    );

    const categoryIds = new Set();

    for (const item of items) {
      if (item.categoryId) {
        categoryIds.add(item.categoryId);
      }

      if (item.subcategoryId) {
        categoryIds.add(item.subcategoryId);
      }
    }

    // Include parent categories for assigned items.
    const categoryMap = new Map(
      allCategories.map(category => [
        category.id,
        category
      ])
    );

    for (const categoryId of [...categoryIds]) {
      const category = categoryMap.get(categoryId);

      if (category && category.parentId) {
        categoryIds.add(category.parentId);
      }
    }

    const categories = allCategories
      .filter(category => categoryIds.has(category.id))
      .map(category => ({
        id: category.id,
        name: String(category.name || ''),
        parentId: String(category.parentId || '')
      }));

    const brands = allBrands
      .filter(brand => allowedBrands.has(brand.id))
      .map(brand => ({
        id: brand.id,
        name: String(brand.name || '')
      }));

    // 7. Calculate stock and valuation for allowed items.
    const resultItems = items.map(item => {
      const itemId = item.id;

      const openingQty = n(item.openingStock);

      let qty = openingQty;

      // Purchased stock increases quantity.
      qty += byItem(
        purchases,
        itemId,
        (_doc, line) => n(line.qty)
      );

      // Sold stock decreases quantity.
      qty -= byItem(
        sales,
        itemId,
        (_doc, line) => n(line.qty)
      );

      // Purchase returns decrease quantity when goods
      // were actually returned.
      for (const doc of purchaseReturns) {
        if (doc.goodsBack !== false) {
          qty -= lines(doc).reduce(
            (sum, line) =>
              sum +
              (
                line.itemId === itemId
                  ? n(line.qty)
                  : 0
              ),
            0
          );
        }
      }

      // Sales returns increase quantity when goods
      // were actually received back.
      for (const doc of saleReturns) {
        if (doc.goodsBack !== false) {
          qty += lines(doc).reduce(
            (sum, line) =>
              sum +
              (
                line.itemId === itemId
                  ? n(line.qty)
                  : 0
              ),
            0
          );
        }
      }

      // Apply stock adjustments.
      for (const adjustment of adjustments) {
        if (adjustment.itemId === itemId) {
          qty += n(adjustment.delta);
        }
      }

      // Calculate weighted-average inventory cost.
      let costQty = openingQty;

      let costValue =
        openingQty *
        (
          n(item.openingRate) ||
          n(item.purchaseRate)
        );

      for (const purchase of purchases) {
        for (const line of lines(purchase)) {
          if (line.itemId === itemId) {
            costQty += n(line.qty);

            costValue +=
              n(line.qty) * n(line.rate);
          }
        }
      }

      // Include positive adjustments with a known cost.
      for (const adjustment of adjustments) {
        if (
          adjustment.itemId === itemId &&
          n(adjustment.delta) > 0 &&
          n(adjustment.rate) > 0
        ) {
          costValue +=
            n(adjustment.delta) *
            n(adjustment.rate);

          costQty += n(adjustment.delta);
        }
      }

      const avgCost =
        costQty > 0
          ? costValue / costQty
          : (
              n(item.purchaseRate) ||
              n(item.openingRate)
            );

      // Return only approved inventory fields.
      // Never return the full source item document.
      return {
        id: itemId,
        name: String(item.name || ''),
        sku: String(item.sku || ''),
        brandId: String(item.brandId || ''),
        categoryId: String(item.categoryId || ''),
        subcategoryId: String(item.subcategoryId || ''),
        low: n(item.low) || 10,
        qty: qty,
        avgCost: avgCost,
        stockValue: qty * avgCost
      };
    });

    // 8. Return only sanitized data.
    return {
      items: resultItems,
      brands: brands,
      categories: categories,
      generatedAt: Date.now()
    };
  }
);
