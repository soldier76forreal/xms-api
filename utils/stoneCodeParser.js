const STONE_TYPES = {
  TR: 'Travertine', MA: 'Marble',   GR: 'Granite',  ON: 'Onyx',
  QU: 'Chinese Granite', LI: 'Limestone', BA: 'Basalt', AL: 'Alabaster',
  CR: 'Crystal',   AN: 'Andesite',  TO: 'Traonyx',  TM: 'Tramite', OT: 'Other',
};

const GRADES = {
  Q:  { name: 'Super',      rank: 1 },
  W:  { name: 'Momtaz',     rank: 2 },
  E:  { name: 'Grade 1',    rank: 3 },
  R:  { name: 'Grade 2',    rank: 4 },
  T:  { name: 'Grade 3',    rank: 5 },
  QS: { name: 'Super Plus', rank: 0 },
  WS: { name: 'Momtaz Plus',rank: 2 },
};

const CUT_LABELS    = { V: 'Veincut',   C: 'Crosscut'  };
const FILL_LABELS   = { F: 'Filled',    U: 'Unfilled'  };
const FINISH_LABELS = { P: 'Polished',  H: 'Honed'     };

// XX##G(1-2)LLLL(4)WW(2)TT(2)[VC]?[FU]?[PH]?
const CODE_REGEX = /^([A-Z]{2})(\d{2})([A-Z]{1,2})(\d{4})(\d{2})(\d{2})([VC]?)([FU]?)([PH]?)$/;

function parseStoneCode(rawCode) {
  if (!rawCode || typeof rawCode !== 'string') {
    return { raw: rawCode, valid: false, parseWarnings: ['No code provided'] };
  }

  const raw = rawCode;
  const code = rawCode.trim().toUpperCase();
  const warnings = [];

  const match = CODE_REGEX.exec(code);
  if (!match) {
    return {
      raw, valid: false,
      parseWarnings: [`"${code}" does not match expected format XX##GLLLLWWTT[VC][FU][PH]`],
    };
  }

  const [, stoneType, quarryCode, grade, llll, ww, tt, cut, fill, finish] = match;

  // LLLL encodes length in mm (1000 → 100.0 cm); WW in cm; TT in mm
  const lengthCm    = parseInt(llll, 10) / 10;
  const widthCm     = parseInt(ww, 10);
  const thicknessMm = parseInt(tt, 10);

  if (!STONE_TYPES[stoneType]) warnings.push(`Unknown stone type: ${stoneType}`);
  if (!GRADES[grade])          warnings.push(`Non-standard grade: ${grade}`);

  const unsized = lengthCm === 0 && widthCm === 0;
  if (unsized) {
    warnings.push('Zero length and width — unsized slab, sold by area/thickness only');
  } else if (lengthCm === 0 || widthCm === 0) {
    warnings.push('One dimension is zero — verify dimensions');
  }

  return {
    raw,
    valid: true,
    productCode:   `${stoneType}${quarryCode}`,
    stoneType,
    stoneTypeName: STONE_TYPES[stoneType] || stoneType,
    quarryCode,
    grade,
    gradeName:     GRADES[grade]?.name  ?? grade,
    gradeRank:     GRADES[grade]?.rank  ?? null,
    lengthCm,
    widthCm,
    thicknessMm,
    unsized,
    cut:        cut    || null,
    cutName:    cut    ? CUT_LABELS[cut]    : null,
    fill:       fill   || null,
    fillName:   fill   ? FILL_LABELS[fill]   : null,
    finish:     finish || null,
    finishName: finish ? FINISH_LABELS[finish] : null,
    parseWarnings: warnings,
  };
}

// The inverse of parseStoneCode: specification -> code (XX##GLLLLWWTT[VC][FU][PH]).
// `code` stays '' while anything is wrong; `errors` names every field that is.
function buildStoneCode(spec = {}) {
  const errors = {};
  const productCode = String(spec.productCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}\d{2}$/.test(productCode)) errors.productCode = true;

  const grade = String(spec.grade || '').trim().toUpperCase();
  if (!/^[A-Z]{1,2}$/.test(grade)) errors.grade = true;

  let lengthTenths = 0;
  let widthCm = 0;
  if (!spec.unsized) {
    const length = Number(spec.lengthCm);
    lengthTenths = Math.round(length * 10);
    if (!(length > 0) || lengthTenths < 1 || lengthTenths > 9999) errors.lengthCm = true;
    widthCm = Number(spec.widthCm);
    if (!Number.isInteger(widthCm) || widthCm < 1 || widthCm > 99) errors.widthCm = true;
  }
  const thicknessMm = Number(spec.thicknessMm);
  if (!Number.isInteger(thicknessMm) || thicknessMm < 1 || thicknessMm > 99) errors.thicknessMm = true;

  const pick = (value, allowed) => (allowed.includes(String(value || '').toUpperCase()) ? String(value).toUpperCase() : '');
  const cut = pick(spec.cut, ['V', 'C']);
  const fill = pick(spec.fill, ['F', 'U']);
  const finish = pick(spec.finish, ['P', 'H']);

  if (Object.keys(errors).length) return { code: '', errors };
  const pad = (n, width) => String(n).padStart(width, '0');
  return {
    code: `${productCode}${grade}${pad(lengthTenths, 4)}${pad(widthCm, 2)}${pad(thicknessMm, 2)}${cut}${fill}${finish}`,
    errors: {},
  };
}

module.exports = {
  parseStoneCode,
  buildStoneCode,
  STONE_TYPES,
  GRADES,
  CUT_LABELS,
  FILL_LABELS,
  FINISH_LABELS,
};
