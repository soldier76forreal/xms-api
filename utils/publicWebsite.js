// Shared projection for every /public/website/* route (api/routes/public/website.js).
// SINGLE CHOKEPOINT rule: no route in that file may spread/return a raw
// Mongoose product/variant document directly — always through these two
// functions. That's what makes "price never reaches the public site" a
// property of the code, not a habit every route has to remember on its own:
// a future internal field added to inventoryProductModel/inventoryVariantModel
// can never leak here just by existing, since these explicitly list every
// field they pass through rather than passing through everything minus a
// blocklist.

// Variant → public shape. quantity/unit ARE included (Pouriya: "quantity must
// be visible at the website"); price/priceRange/currency are never selected.
function toPublicVariant(v) {
  return {
    _id: v._id,
    code: v.code,
    spec: {
      grade: v.spec?.grade, gradeName: v.spec?.gradeName,
      lengthCm: v.spec?.lengthCm, widthCm: v.spec?.widthCm, thicknessMm: v.spec?.thicknessMm,
      unsized: v.spec?.unsized,
      cut: v.spec?.cut, cutName: v.spec?.cutName,
      fill: v.spec?.fill, fillName: v.spec?.fillName,
      finish: v.spec?.finish, finishName: v.spec?.finishName,
    },
    unit: v.unit,
    quantity: v.quantity,
    inStock: (v.quantity || 0) > 0,
  };
}

// Product → public shape, `lang` picks which of the three name/description
// fields to surface as the plain `name`/`description` the frontend reads —
// callers that need all three languages at once (e.g. building a sitemap)
// should read `raw.name/nameAr/nameFa` instead of calling this per-language.
const SEO_KEY_SUFFIX = { en: '', ar: 'Ar', fa: 'Fa' };

function toPublicProduct(p, { lang = 'en', variants = [], includeContent = false } = {}) {
  const nameByLang = { en: p.name, ar: p.nameAr, fa: p.nameFa };
  const descByLang = { en: p.description, ar: p.descriptionAr, fa: p.descriptionFa };
  const suffix = SEO_KEY_SUFFIX[lang] || '';
  const seo = p.website?.seo || {};
  const out = {
    _id: p._id,
    branchId: p.branchId,
    code: p.code,
    stoneTypeName: p.stoneTypeName,
    quarryName: p.quarryName,
    name: nameByLang[lang] || p.name || '',
    description: descByLang[lang] || p.description || '',
    slug: p.website?.slug || null,
    gallery: (p.website?.gallery || [])
      .slice().sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((g) => ({ fileId: g.fileId, diskName: g.diskName })),
    tags: p.website?.tags || [],
    seo: {
      metaTitle: seo[`metaTitle${suffix}`] || nameByLang[lang] || p.name || '',
      metaDescription: seo[`metaDescription${suffix}`] || descByLang[lang] || '',
    },
    totalsByUnit: p.totalsByUnit || {},
    variants: variants.map(toPublicVariant),
  };
  // Long-form SEO sections — only worth the payload on the single-product
  // route, never the list (24+ products × 6 HTML blocks would bloat it).
  if (includeContent) {
    const c = p.website?.content || {};
    out.content = {
      introduction: c[`introduction${suffix}`] || c.introduction || '',
      features: c[`features${suffix}`] || c.features || '',
      applications: c[`applications${suffix}`] || c.applications || '',
      whyUs: c[`whyUs${suffix}`] || c.whyUs || '',
      careTips: c[`careTips${suffix}`] || c.careTips || '',
      conclusion: c[`conclusion${suffix}`] || c.conclusion || '',
    };
  }
  return out;
}

// Mongoose .select() strings — used at the QUERY level (defense in depth: even
// if a route forgets to call toPublicProduct/toPublicVariant, price was never
// fetched from Mongo in the first place).
const PUBLIC_PRODUCT_SELECT = 'branchId code stoneTypeName quarryName name nameAr nameFa description descriptionAr descriptionFa website totalsByUnit';
const PUBLIC_VARIANT_SELECT = 'productId branchId code spec unit quantity status categories';

module.exports = { toPublicProduct, toPublicVariant, PUBLIC_PRODUCT_SELECT, PUBLIC_VARIANT_SELECT };
