// Network fallback lookups, tried when rungs 1-3 miss locally (or for rung
// 4, which is network-only — see catalogue.js for why local fuzzy search
// was dropped).
//
// THE BNP/PORBASE PATH IS UNREACHABLE FROM A BROWSER. It is kept, and kept
// correct, but nothing here enables it. Two independent faults, one of which
// was masking the other (full write-up: docs/bnp-findings.md, addendum):
//
//   1. CORS (tested 2026-08-19). urn.bnportugal.gov.pt and urn.porbase.org
//      send no Access-Control-Allow-Origin header, so browser fetches fail
//      with an opaque CORS error even though the endpoints work fine
//      server-side. Failures are swallowed and the ladder moves on.
//   2. The URLs were wrong (found 2026-08-31, testing server-side where
//      CORS doesn't apply). The old `/{scheme}/{value}` shape returns
//      "Pedido inválido - não contém forma" — it is not the interface. The
//      real one is `/{scheme}/{schema}/{serialization}?id={value}`. So this
//      fallback would have returned nothing even with a working proxy.
//
// Fault 2 is fixed below and fault 1 is not, so these calls still never
// succeed in the browser — but they are now correct for whenever CORS is
// solved (a proxy, or BNP simply sending the header, which is a pending ask).
// Do not read a passing test as evidence this path works end to end; it
// cannot be exercised end to end from a page.
//
//   - openlibrary.org and covers.openlibrary.org: send
//     `access-control-allow-origin: *`. These work directly from the
//     browser and are the only network sources this pilot can actually
//     reach client-side.
//
// Every successful hit is cached into IndexedDB permanently (editions_cache)
// so the same edition is never fetched twice.
window.App = window.App || {};

App.network = (function () {
  const OL_UA = "pt-book-encounter-pilot/0.1 (single-user pilot; contact via GitHub repo)";

  async function tryFetch(url, opts) {
    try {
      const res = await fetch(url, opts);
      if (!res.ok) return null;
      return res;
    } catch (err) {
      return null; // network error, CORS block, offline, etc. — non-fatal
    }
  }

  // UNIMARC non-filing-character markers (NSB/NSE) wrap a leading article so
  // it sorts under the next word. PORBASE leaks them transcoded to "?" —
  // "?A ?nuvem cor-de-rosa" — where BNP returns "À nuvem cor-de-rosa" for the
  // same ISBN. Strip only the PAIRED signature (leading marker, a short
  // article, closing marker) rather than every "?", so a title that genuinely
  // contains a question mark survives.
  function stripNonFiling(s) {
    if (!s) return "";
    return s
      .replace(/[\u0088\u0089\u0098\u009C]/g, "")
      .replace(/^\?(.{1,9}?)\?/, "$1")
      .trim();
  }

  // Parses a MODS record from the BNP/PORBASE URN resolver into the same
  // edition shape catalogue.js's rowToEdition produces.
  //
  // Written against real captured responses (see docs/bnp-findings.md
  // addendum), replacing a version written blind against a guessed schema —
  // that one looked for flat <author>/<date> elements which don't exist in
  // MODS, so it silently returned an edition with no author and no year on
  // every lookup.
  function parseUrnXml(text, source) {
    try {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.querySelector("parsererror")) return null;
      // "Registo inexistente" (valid request, no match) and "Pedido inválido"
      // (malformed request) both come back as <error> with HTTP 200.
      if (doc.querySelector("error")) return null;

      const txt = (el) => (el && el.textContent ? el.textContent.trim() : "");
      const one = (sel) => txt(doc.querySelector(sel));
      const all = (sel) => Array.from(doc.querySelectorAll(sel));

      const title = stripNonFiling(one("mods > titleInfo > title"));
      if (!title) return null;

      // Prefer the structured personal names over the free-text displayForm:
      // displayForm is a single transcribed statement of responsibility
      // ("Arsénio Mota ; il. Júlio Resende"), while namePart gives each
      // agent separately in indexed form ("Mota, Arsénio, 1930-").
      let authors = all("mods > name[type='personal'] > namePart")
        .map(txt)
        .filter(Boolean)
        .join(" ; ");
      if (!authors) authors = txt(doc.querySelector("mods > name > displayForm"));

      // Two <place> blocks appear: the city, then the ISO country. Take the
      // first text-form term, which is the city.
      const place = txt(
        doc.querySelector("mods > originInfo > place > placeTerm:not([authority='iso-3166'])")
      );

      // dateOther carries the plain year ("2008"); dateIssued is a full date
      // ("2008-01-01"). Either way the app only wants the year.
      const rawYear = one("mods > originInfo > dateOther") || one("mods > originInfo > dateIssued");
      const yearMatch = /\b(\d{4})\b/.exec(rawYear || "");

      const isbnRaw = one("mods > identifier[type='isbn']");
      const isbn13 = isbnRaw ? isbnRaw.replace(/[^0-9Xx]/g, "") : "";

      return {
        bnp_record_id: one("mods > recordInfo > recordIdentifier"),
        title,
        subtitle: stripNonFiling(one("mods > titleInfo > subTitle")),
        authors,
        publisher: one("mods > originInfo > publisher"),
        place,
        year: yearMatch ? yearMatch[1] : "",
        edition: one("mods > originInfo > edition"),
        pages: one("mods > physicalDescription > extent"),
        language: one("mods > language > languageTerm[type='code']"),
        isbn13: isbn13.length === 13 ? isbn13 : "",
        // NOT mapped: <identifier type="stock">, which holds the Depósito
        // Legal ("PT - 272507/08", confirmed against our own build — BNP
        // record 1731654 carries deposito_legal 272507/08). Deliberately left
        // unset: DL now drives the dex ordinal and the discovery grid, so a
        // misread of a field whose semantics aren't formally documented would
        // corrupt exactly the data this project is built on. Map it once BNP
        // confirms what "stock" means. See docs/bnp-findings.md addendum §4.
        source: source,
      };
    } catch (err) {
      return null;
    }
  }

  // The URN resolver's request shape, shared by BNP and PORBASE (verified
  // against both): /{scheme}/{schema}/{serialization}?id={value}. The
  // "schema/serialization" segments are the "forma" the old URL was missing —
  // omitting them yields "Pedido inválido - não contém forma", not a record.
  // ISBNs may be passed unhyphenated (verified), so no hyphenation step and
  // no ISBN registrant-range tables are needed.
  function urnIsbnUrl(host, isbn) {
    return `https://${host}/isbn/mods/xml?id=${encodeURIComponent(isbn)}`;
  }

  async function fetchFromBNP(isbn) {
    const res = await tryFetch(urnIsbnUrl("urn.bnportugal.gov.pt", isbn));
    if (!res) return null;
    return parseUrnXml(await res.text(), "bnp-urn");
  }

  async function fetchFromPorbase(isbn) {
    const res = await tryFetch(urnIsbnUrl("urn.porbase.org", isbn));
    if (!res) return null;
    return parseUrnXml(await res.text(), "porbase-urn");
  }

  async function fetchFromOpenLibrary(isbn) {
    const url =
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
    // Note: browsers do not allow scripts to set the User-Agent header
    // (it's a forbidden header per the Fetch spec) — the spec's "send a
    // User-Agent naming the app" instruction is only actionable server-side.
    // OL_UA is kept above for documentation and in case this ever runs
    // through a proxy/service-worker that can attach it.
    const res = await tryFetch(url);
    if (!res) return null;
    const data = await res.json();
    const key = `ISBN:${isbn}`;
    const entry = data[key];
    if (!entry) return null;
    return {
      title: entry.title || "",
      authors: (entry.authors || []).map((a) => a.name).join(" ; "),
      publisher: (entry.publishers || []).map((p) => p.name).join(" ; "),
      place: (entry.publish_places || []).map((p) => p.name).join(" ; "),
      year: entry.publish_date || "",
      pages: entry.number_of_pages ? String(entry.number_of_pages) : "",
      cover_url: entry.cover ? entry.cover.medium || entry.cover.large : null,
      source: "openlibrary",
    };
  }

  function coverUrl(isbn) {
    return `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`;
  }

  // Tries BNP -> PORBASE -> OpenLibrary, in the order the spec asks for.
  // Caches the first hit. Returns null if nothing answered (including the
  // very likely case that BNP/PORBASE are CORS-blocked).
  async function lookupByIsbn(isbn13) {
    const cacheKey = `isbn:${isbn13}`;
    const cached = await App.idb.cacheGet(cacheKey);
    if (cached) return cached.edition;

    let edition =
      (await fetchFromBNP(isbn13)) ||
      (await fetchFromPorbase(isbn13)) ||
      (await fetchFromOpenLibrary(isbn13));

    if (edition) {
      await App.idb.cachePut(cacheKey, edition, edition.source);
    }
    return edition;
  }

  // DL-keyed network lookup: NOT IMPLEMENTED, and deliberately not guessed at.
  //
  // Only BNP/PORBASE could answer it — OpenLibrary has no concept of Depósito
  // Legal. BNP's acesso.urn docs do list Legal Deposit Number as a supported
  // identifier space, but the scheme name it goes by is undocumented and none
  // of the plausible ones resolve: /dl/, /depositolegal/ and /stock/ all 404
  // against /{scheme}/mods/xml?id= (tested 2026-08-31). The previous code
  // shipped `/dl/{value}`, which was wrong twice over — wrong scheme name AND
  // the old formaless URL shape.
  //
  // Returning null outright rather than firing a request known to 404: a
  // request that cannot succeed is not a fallback, it's a slow no. Asking BNP
  // for the scheme name is a pending item — see docs/bnp-findings.md addendum
  // §4 and §7. Note DL *is* present in the response as
  // <identifier type="stock">, so this is an input-side gap only.
  //
  // The cache read is kept so that anything cached by an older build, or by a
  // future working implementation, still resolves.
  async function lookupByDL(dl) {
    const cached = await App.idb.cacheGet(`dl:${dl}`);
    return cached ? cached.edition : null;
  }

  // Rung 4: network-only fuzzy title/author search (local FTS was dropped,
  // see catalogue.js). OpenLibrary's /search.json is CORS-open and does its
  // own relevance ranking; we just clean up the raw OCR text a little and
  // hand it over as a free-text query. Coverage for obscure or pre-1988
  // Portuguese titles will often be weak — OpenLibrary skews modern/
  // commercial — but per spec this always returns a ranked candidate list
  // for the user to pick from, never a single accepted answer, so a weak
  // or empty result list is a normal, honest outcome here.
  async function searchByText(rawOcrText, limit) {
    const cleaned = (rawOcrText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200); // titles pages are verbose; cap query length
    if (!cleaned) return [];

    const url =
      "https://openlibrary.org/search.json?" +
      "q=" + encodeURIComponent(cleaned) +
      "&limit=" + (limit || 5) +
      "&fields=title,author_name,first_publish_year,publisher,isbn";
    const res = await tryFetch(url);
    if (!res) return [];
    const data = await res.json();
    return (data.docs || []).map((d) => ({
      title: d.title || "",
      authors: (d.author_name || []).join(" ; "),
      publisher: (d.publisher || [])[0] || "",
      year: d.first_publish_year || "",
      isbn13: (d.isbn || []).find((i) => /^97[89]\d{10}$/.test(i)) || null,
      source: "openlibrary-search",
    }));
  }

  return {
    fetchFromBNP, fetchFromPorbase, fetchFromOpenLibrary, coverUrl,
    lookupByIsbn, lookupByDL, searchByText,
  };
})();
