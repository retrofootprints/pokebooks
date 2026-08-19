// Network fallback lookups, tried when rungs 1-3 miss locally (or for rung
// 4, which is network-only — see catalogue.js for why local fuzzy search
// was dropped).
//
// CORS finding (tested 2026-08-19, see docs/bnp-findings.md addendum):
//   - urn.bnportugal.gov.pt and urn.porbase.org: no
//     Access-Control-Allow-Origin header. Browser fetches to these WILL
//     fail with an opaque CORS error, even though the endpoints work fine
//     server-side (confirmed via curl: GET .../isbn/<isbn> returns XML).
//     They're still attempted here in case that changes; failures are
//     swallowed silently and the ladder just moves on. A same-origin proxy
//     would be needed to actually use these from a static GitHub Pages
//     site — explicitly out of scope for this pilot per the spec.
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

  function parseUrnXml(text) {
    // BNP/PORBASE urn-response XML. Kept defensive since we've never seen
    // a real non-error response (CORS blocks it in-browser) — this is
    // best-effort for if a future proxy or CORS change makes it reachable.
    try {
      const doc = new DOMParser().parseFromString(text, "application/xml");
      if (doc.querySelector("parsererror")) return null;
      if (doc.querySelector("error")) return null;
      const get = (tag) => doc.querySelector(tag)?.textContent?.trim() || "";
      const title = get("title") || get("titulo");
      if (!title) return null;
      return {
        title,
        authors: get("author") || get("autor"),
        publisher: get("publisher") || get("editor"),
        place: get("place") || get("local"),
        year: get("date") || get("data"),
      };
    } catch (err) {
      return null;
    }
  }

  async function fetchFromBNP(isbn) {
    const res = await tryFetch(`https://urn.bnportugal.gov.pt/isbn/${isbn}`);
    if (!res) return null;
    const text = await res.text();
    const parsed = parseUrnXml(text);
    return parsed ? Object.assign(parsed, { source: "bnp-urn" }) : null;
  }

  async function fetchFromPorbase(isbn) {
    const res = await tryFetch(`https://urn.porbase.org/isbn/${isbn}`);
    if (!res) return null;
    const text = await res.text();
    const parsed = parseUrnXml(text);
    return parsed ? Object.assign(parsed, { source: "porbase-urn" }) : null;
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

  async function lookupByDL(dl) {
    const cacheKey = `dl:${dl}`;
    const cached = await App.idb.cacheGet(cacheKey);
    if (cached) return cached.edition;

    // DL-keyed lookup only makes sense against BNP/PORBASE (OpenLibrary has
    // no concept of Depósito Legal). Both are CORS-blocked as noted above,
    // so in practice this will return null until that changes or a proxy
    // exists — logged honestly rather than pretending it works.
    const encoded = encodeURIComponent(dl);
    const res = await tryFetch(`https://urn.bnportugal.gov.pt/dl/${encoded}`);
    let edition = null;
    if (res) {
      const parsed = parseUrnXml(await res.text());
      edition = parsed ? Object.assign(parsed, { source: "bnp-urn" }) : null;
    }
    if (edition) await App.idb.cachePut(cacheKey, edition, edition.source);
    return edition;
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
