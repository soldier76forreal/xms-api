// The fonts a printed or previewed document is set in.
//
//   Arabic document  → Amiri
//   Farsi document   → B Nazanin
//   English document → unchanged (the system stack it always used)
//
// WHY EMBEDDED. A document reaches three places and only one of them can fetch a file by URL:
// the in-app preview (an iframe with sandbox="", i.e. an opaque origin that may not load a font
// cross-origin), the browser's print dialog, and the server's own PDF render (an in-memory page
// with no server behind it). A data: URI works in all three, so the @font-face rules carry the
// font bytes themselves — the same reason the logo is a data URI in these templates. The fonts
// are WOFF2 (Amiri ≈ 160 KB per weight, B Nazanin 21 KB), read from disk once.
//
// WHICH CHARACTERS. Each face is limited to the Arabic script (plus the zero-width joiner and the
// direction marks) with unicode-range, so the Latin letters and the DIGITS of a document keep
// coming from the Latin font after it in the stack. That matters: B Nazanin draws the ASCII digits
// as Persian digits and has no Latin letters at all, and Amiri's Latin is a serif — neither belongs
// beside a price or a stone code. This is the same split the app's own UI uses (xms/src/index.css).
//
// size-adjust scales each face to read at the size the templates were laid out for.
//
// If a font file is missing (a partial deploy) the document simply falls back to the stack that
// follows — it never fails to render.
const fs = require('fs');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');

const ARABIC_SCRIPT = 'U+0600-06FF, U+0750-077F, U+08A0-08FF, U+FB50-FDFF, U+FE70-FEFF, U+200C-200F';

const FACES = {
  ar: [
    { family: 'Amiri', file: 'Amiri-Regular.woff2', weight: 400, sizeAdjust: '112%' },
    { family: 'Amiri', file: 'Amiri-Bold.woff2', weight: 700, sizeAdjust: '112%' },
  ],
  // Only the regular weight exists, so bold text is the browser's synthesized bold.
  fa: [
    { family: 'BNazanin', file: 'BNazanin.woff2', weight: 400, sizeAdjust: '120%' },
  ],
};

const encoded = {};
function dataUri(file) {
  if (!(file in encoded)) {
    try {
      encoded[file] = `data:font/woff2;base64,${fs.readFileSync(path.join(FONT_DIR, file)).toString('base64')}`;
    } catch (_) {
      encoded[file] = null;
    }
  }
  return encoded[file];
}

// The faces of a language that are actually on disk.
const available = (lang) => (FACES[lang] || []).filter((f) => dataUri(f.file));

/** The @font-face rules for a document language ('' for a language with no special face). */
function fontFaceCss(lang) {
  return available(lang).map((f) => `@font-face {
    font-family: '${f.family}'; src: url(${dataUri(f.file)}) format('woff2');
    font-weight: ${f.weight}; font-style: normal; size-adjust: ${f.sizeAdjust};
    unicode-range: ${ARABIC_SCRIPT};
  }`).join('\n  ');
}

/** A font-family value: the language's face first (when it exists), then `rest`. */
function fontStack(lang, rest = "'Segoe UI', Tahoma, Arial, sans-serif") {
  const first = [...new Set(available(lang).map((f) => `'${f.family}'`))];
  return [...first, rest].join(', ');
}

/**
 * Everything a template adds to its <style> to be set in the language's face: the @font-face
 * rules and a body font-family that puts the face first. Empty for a language without one
 * (English), so such a document is byte-for-byte what it always was — which is why it carries its
 * own leading newline instead of the template spending a line on it. Put it LAST in the style
 * block: it overrides the body rule above it.
 */
function documentFontCss(lang) {
  const faces = fontFaceCss(lang);
  return faces ? `\n  ${faces}\n  body { font-family: ${fontStack(lang)}; }` : '';
}

module.exports = { fontFaceCss, fontStack, documentFontCss };
