// Shared projection for /public/website/blog* — mirrors utils/publicWebsite.js's
// "single chokepoint" rule: no route may spread/return a raw blogPost
// Mongoose document. Draft-only fields (status, createdBy, other-language
// content) never need a blocklist because they're just never copied in.
const SEO_KEY_SUFFIX = { en: '', ar: 'Ar', fa: 'Fa' };

function toPublicBlogListItem(p, lang = 'en') {
  const titleByLang = { en: p.title, ar: p.titleAr, fa: p.titleFa };
  const excerptByLang = { en: p.excerpt, ar: p.excerptAr, fa: p.excerptFa };
  return {
    _id: p._id,
    slug: p.slug,
    title: titleByLang[lang] || p.title || '',
    excerpt: excerptByLang[lang] || p.excerpt || '',
    coverImage: p.coverImage?.diskName ? { diskName: p.coverImage.diskName } : null,
    publishedAt: p.publishedAt,
  };
}

function toPublicBlogPost(p, lang = 'en') {
  const titleByLang = { en: p.title, ar: p.titleAr, fa: p.titleFa };
  const excerptByLang = { en: p.excerpt, ar: p.excerptAr, fa: p.excerptFa };
  const bodyByLang = { en: p.body, ar: p.bodyAr, fa: p.bodyFa };
  const suffix = SEO_KEY_SUFFIX[lang] || '';
  const seo = p.seo || {};
  return {
    _id: p._id,
    slug: p.slug,
    title: titleByLang[lang] || p.title || '',
    excerpt: excerptByLang[lang] || p.excerpt || '',
    body: bodyByLang[lang] || p.body || '',
    coverImage: p.coverImage?.diskName ? { diskName: p.coverImage.diskName } : null,
    publishedAt: p.publishedAt,
    seo: {
      metaTitle: seo[`metaTitle${suffix}`] || titleByLang[lang] || p.title || '',
      metaDescription: seo[`metaDescription${suffix}`] || excerptByLang[lang] || '',
    },
  };
}

// Mongoose .select() strings — defense in depth, same pattern as
// PUBLIC_PRODUCT_SELECT: draft/internal fields are never fetched at all.
const PUBLIC_BLOG_LIST_SELECT = 'slug title titleAr titleFa excerpt excerptAr excerptFa coverImage publishedAt';
const PUBLIC_BLOG_POST_SELECT = 'slug title titleAr titleFa excerpt excerptAr excerptFa body bodyAr bodyFa coverImage publishedAt seo';

module.exports = { toPublicBlogListItem, toPublicBlogPost, PUBLIC_BLOG_LIST_SELECT, PUBLIC_BLOG_POST_SELECT };
