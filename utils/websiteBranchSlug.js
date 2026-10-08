const RESERVED = new Set([
  'ar', 'fa', 'product', 'product-category', 'shop', 'about-us',
  'my-account', 'purchase-request', 'contact-us', 'contact', 'blog',
  'product-table', 'product-table-ar', 'search', 'cart', 'checkout',
  'author', 'en', 'api', 'feed', 'wp-content', 'wp-includes', 'fonts',
  '_next', '_xms-media',
]);

function websiteBranchSlug(branch) {
  return String(branch.websiteSlug || branch.name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function validWebsiteBranchSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && !RESERVED.has(slug);
}

module.exports = { websiteBranchSlug, validWebsiteBranchSlug };
