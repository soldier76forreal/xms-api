const stoneTypes = [
  { code: 'TR', name: 'Travertine' },
  { code: 'MA', name: 'Marble' },
  { code: 'GR', name: 'Granite' },
  { code: 'ON', name: 'Onyx' },
  { code: 'QU', name: 'Chinese Granite' },
  { code: 'LI', name: 'Limestone' },
  { code: 'BA', name: 'Basalt' },
  { code: 'AL', name: 'Alabaster' },
  { code: 'CR', name: 'Crystal' },
  { code: 'AN', name: 'Andesite' },
  { code: 'TO', name: 'Traonyx' },
  { code: 'TM', name: 'Tramite' },
  { code: 'OT', name: 'Other' },
];

const grades = [
  { code: 'QS', name: 'Super Plus',  rank: 0 },
  { code: 'Q',  name: 'Super',       rank: 1 },
  { code: 'W',  name: 'Momtaz',      rank: 2 },
  { code: 'E',  name: 'Grade 1',     rank: 3 },
  { code: 'R',  name: 'Grade 2',     rank: 4 },
  { code: 'T',  name: 'Grade 3',     rank: 5 },
];

const units = [
  { code: 'M2',   name: 'Square Metre', nameAr: 'متر مربع' },
  { code: 'ML',   name: 'Linear Metre', nameAr: 'متر طول'  },
  { code: 'PCS',  name: 'Pieces',       nameAr: 'عدد'       },
  { code: 'SQFT', name: 'Square Feet',  nameAr: 'فوت مربع'  },
  { code: 'LNFT', name: 'Linear Feet',  nameAr: 'فوت طول'   },
];

// Known quarries seeded from the PDF inventory
const quarries = [
  { stoneType: 'TR', code: '45', name: 'Beige NR' },
  { stoneType: 'TR', code: '39', name: 'Notcha' },
  { stoneType: 'TR', code: '57', name: 'Silver Platinum' },
  { stoneType: 'MA', code: '01', name: 'Armani Grey' },
  { stoneType: 'MA', code: '25', name: 'Tundra Grey' },
  { stoneType: 'MA', code: '16', name: 'Sunny Grey' },
];

module.exports = { stoneTypes, grades, units, quarries };
