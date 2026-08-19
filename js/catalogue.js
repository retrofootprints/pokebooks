// Local BNP catalogue lookups via sql.js-httpvfs (chunked SQLite over HTTP
// range requests — see scripts/build_index.py and scripts/chunk_db.py).
//
// Only exact identifier lookups (isbn13 / isbn10 / deposito_legal) are
// implemented here, because those are the only indexed columns — see
// docs/bnp-findings.md and the comment in build_index.py for why title/
// author text search was dropped from the local index (it would force a
// full-table scan over a ~320MB db through the range-request VFS, which is
// exactly what chunked httpvfs is meant to avoid). Fuzzy title/author
// matching (rung 4) is network-only; see network.js.
window.App = window.App || {};

App.catalogue = (function () {
  let workerPromise = null;
  let unavailableReason = null;

  async function getWorker() {
    if (unavailableReason) throw new Error(unavailableReason);
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
      try {
        // wasmUrl is resolved by the worker relative to ITS OWN script
        // location (lib/sqljs-httpvfs/), not the page — so this must be a
        // bare filename, not "lib/sqljs-httpvfs/sql-wasm.wasm" (that
        // resolves to a wrongly-doubled lib/sqljs-httpvfs/lib/sqljs-httpvfs/
        // path and 404s). Confirmed by testing against a local server.
        const worker = await createDbWorker(
          [{ from: "jsonconfig", configUrl: "../../db/config.json" }],
          "lib/sqljs-httpvfs/sqlite.worker.js",
          "sql-wasm.wasm"
        );
        return worker;
      } catch (err) {
        unavailableReason = "Local catalogue unavailable: " + err.message;
        throw err;
      }
    })();
    return workerPromise;
  }

  function rowToEdition(cols, row) {
    if (!row) return null;
    const obj = {};
    cols.forEach((c, i) => (obj[c] = row[i]));
    return {
      bnp_record_id: obj.bnp_record_id,
      title: obj.title,
      subtitle: obj.subtitle,
      authors: obj.authors,
      publisher: obj.publisher,
      place: obj.place,
      year: obj.year,
      edition: obj.edition,
      pages: obj.pages,
      language: obj.language,
      isbn13: obj.isbn13,
      isbn10: obj.isbn10,
      deposito_legal: obj.deposito_legal,
      source: "bnp-local",
    };
  }

  async function queryOne(sql, params) {
    const worker = await getWorker();
    const result = await worker.db.exec(sql, params);
    if (!result || !result.length || !result[0].values.length) return null;
    return rowToEdition(result[0].columns, result[0].values[0]);
  }

  async function lookupByIsbn13(isbn13) {
    return queryOne(
      "SELECT bnp_record_id, title, subtitle, authors, publisher, place, year, " +
        "edition, pages, language, isbn13, isbn10, deposito_legal FROM editions " +
        "WHERE isbn13 = ? LIMIT 1",
      [isbn13]
    );
  }

  async function lookupByIsbn10(isbn10) {
    return queryOne(
      "SELECT bnp_record_id, title, subtitle, authors, publisher, place, year, " +
        "edition, pages, language, isbn13, isbn10, deposito_legal FROM editions " +
        "WHERE isbn10 = ? LIMIT 1",
      [isbn10]
    );
  }

  async function lookupByDL(dl) {
    return queryOne(
      "SELECT bnp_record_id, title, subtitle, authors, publisher, place, year, " +
        "edition, pages, language, isbn13, isbn10, deposito_legal FROM editions " +
        "WHERE deposito_legal = ? LIMIT 1",
      [dl]
    );
  }

  // Best-effort local ISBN lookup: try 13 first, then 10.
  async function lookupByIsbn(isbn13, isbn10) {
    if (isbn13) {
      const hit = await lookupByIsbn13(isbn13);
      if (hit) return hit;
    }
    if (isbn10) {
      const hit = await lookupByIsbn10(isbn10);
      if (hit) return hit;
    }
    return null;
  }

  return { lookupByIsbn13, lookupByIsbn10, lookupByDL, lookupByIsbn };
})();
