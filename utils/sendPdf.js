// One way to hand a rendered PDF to the client, shared by every PDF route
// (invoice / quotation, packing list, pallet label, deal letter).
//
// Two transports:
//
//   default            raw bytes + `Content-Disposition: attachment` — for a
//                      direct link, curl, or anything that isn't the app.
//
//   ?transport=base64  JSON { filename, contentType, data } — what the app
//                      always asks for. Download managers that are popular with
//                      our users (Internet Download Manager above all) hook the
//                      browser's network stack and take over any response that
//                      looks like a file download: the page's request gets an
//                      empty 204 with no CORS headers instead (so the app shows
//                      "Failed to download"), and the manager's own re-request
//                      carries no auth token, so nothing lands on disk either.
//                      A JSON body is never treated as a download. The client
//                      rebuilds the file in memory and saves it from a blob URL,
//                      which never touches the network.

// Header-safe filename. Node rejects non-latin1 header bytes outright, and a
// pallet id or contract number can be typed in Persian — keep the digits
// (Persian / Arabic-Indic → Latin) and turn anything else into a dash.
function asciiFilename(name, fallback = 'document.pdf') {
  const safe = String(name || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+(?=\.pdf$)|-+$/gi, '');
  return safe && safe !== '.pdf' ? safe : fallback;
}

// Puppeteer (v22+) resolves page.pdf() to a Uint8Array, not a Buffer —
// Express's res.send() would JSON-serialize that, so always normalize first.
function sendPdf(req, res, pdf, filename) {
  const buf = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  const name = asciiFilename(filename);
  if (req.query && req.query.transport === 'base64') {
    return res.status(200).json({ filename: name, contentType: 'application/pdf', data: buf.toString('base64') });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Length', buf.length);
  return res.status(200).end(buf);
}

module.exports = { sendPdf, asciiFilename };
