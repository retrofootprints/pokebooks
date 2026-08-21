// Minimal i18n: language is decided once at page load (stored preference,
// else browser language, else English) and switching languages reloads the
// page — no live re-rendering complexity. Every other module calls
// App.i18n.t()/tn() fresh each time it builds HTML, so as long as this file
// loads first and sets `lang` before anything renders, the whole app comes
// up consistently in one language. Load this script before every other app
// script in index.html.
window.App = window.App || {};

App.i18n = (function () {
  const STORAGE_KEY = "pt-book-encounters-lang";

  const DICTS = {
    en: {
      appTitle: "Encontros de Livros",
      appSubtitle: "book encounter log — pilot",

      navCapture: "Capture",
      navLog: "Log",
      navMap: "Map",
      navStats: "Stats",

      btnScanBook: "Scan book",
      btnCapturePhoto: "Capture photo",
      btnCancel: "Cancel",
      btnSearch: "Search",
      btnLogAnyway: "Log it anyway — no identification needed",
      btnSaveEncounter: "Save encounter",
      btnExportJson: "Export JSON",
      btnImportJson: "Import JSON",
      btnReject: "Reject",
      btnEdit: "Edit",
      btnConfirm: "Confirm",

      searchPlaceholder: "Search title or author…",
      locationNotePlaceholder: "e.g. Alfarrabista da Rua Anchieta",

      manualHeadingLog: "Log this encounter",
      manualHeadingConfirm: "Confirm details",

      fieldTitle: "Title",
      fieldAuthor: "Author",
      fieldPublisher: "Publisher",
      fieldYear: "Year",
      fieldPublished: "Published",
      fieldPages: "Pages",
      fieldIsbn: "ISBN",
      fieldDepositoLegal: "Depósito Legal",
      fieldDetectedIsbn: "Detected ISBN",
      fieldDetectedDl: "Detected Depósito Legal",
      fieldContext: "Context",
      fieldLocationNote: "Location note (optional)",
      fieldNote: "Personal note (optional)",

      ctxShop: "shop",
      ctxLibrary: "library",
      ctxFriend: "friend",
      ctxFair: "fair",
      ctxSecondhand: "secondhand",
      ctxOwned: "owned",
      ctxOther: "other",

      rungBarcode: "Barcode",
      rungIsbn: "Printed ISBN",
      rungDl: "Depósito Legal",
      rungTitleMatch: "Title match",
      rungManual: "Logged by hand",

      filterAll: "all",

      untitled: "(untitled)",
      noTitle: "(no title)",
      unidentifiedEncounter: "Unidentified encounter",

      sourceNote: "Source: {source}. OCR/network data is not authoritative — check before confirming.",
      candidatesIntro: "No exact identifier found. Ranked candidates from title-page text (pick one, or reject to log by hand):",
      identifierNoMatch: "Identifier detected but no catalogue or network match:",
      suggestedFieldsIntro: "Suggested from the page text (unverified — check before saving):",
      catalogueGapBadge: "Not catalogued",
      stillLogByHand: "You can still log this — fill in what you know by hand.",
      noIdentifierFound: "No identifier found in this photo.",
      ocrTextSample: "OCR text (first 200 chars): {text}",

      logHeading: "Log",
      noEncountersYet: "No encounters logged yet.",

      mapHeading: "Map",
      statsHeading: "Stats",
      statsRungDistribution: "Rung distribution",
      statsByContext: "By context",
      statTotalEncounters: "total encounters",
      statDistinctEditions: "distinct editions",
      statUnidentified: "unidentified",
      statIdentified: "identified",
      dexCompletionTitle: "Catalogue completion",
      dexCompletionLine: "{count} of {total} BNP-catalogued books logged ({pct}%)",
      dexCompletionNote: "Books BNP has catalogued as of {date} — not every book ever published in Portugal. See the README for why.",
      dexCompletionUnavailable: "Catalogue completion data unavailable.",
      discoveryGridTitle: "Discovery grid (this device)",
      discoveryGridNote: "Each square is {bucket} consecutive Depósito Legal numbers, oldest at top-left to newest at bottom-right. Shaded by how many you've logged on this device — there's no shared/multi-user data yet, so this can't show what others have found.",
      discoveryGridLess: "Less",
      discoveryGridMore: "More",
      discoveryGridUnavailable: "Discovery grid data unavailable.",
      noContextYet: "No context data yet.",

      statusScanPrompt: "Point at a barcode, or tap Capture to photograph the page.",
      statusCameraUnavailable: "Camera unavailable: {msg}",
      statusReadingText: "Reading text (this can take a few seconds)…",
      statusTryingRotation: "Reading text — that angle didn't work, trying another orientation ({i}/{total})…",
      statusSearching: "Searching…",
      statusNoResults: "No results.",

      toastLookingUp: "Looking up {isbn}…",
      toastNotBookBarcode: "Not a book barcode (rejected): {raw}",
      toastCaptureFailed: "Capture failed: {msg}",
      toastOcrFailed: "OCR failed: {msg} — you can still log it by hand.",
      toastEncounterSaved: "Encounter saved.",
      toastEncounterSavedNoLocation: "Encounter saved (no location: {reason}).",
      locationReasonDenied: "permission denied",
      locationReasonTimeout: "timed out",
      locationReasonUnavailable: "unavailable",
      locationReasonUnsupported: "not supported by this browser",
      locationReasonNotEnabled: "not enabled",

      locBannerPrompt: "Add location to your encounters? Rounded to ~11 km — the exact position is never stored.",
      locBannerEnable: "Use GPS",
      locBannerSetManual: "Set manually",
      locBannerActiveGps: "Location: GPS",
      locBannerActiveManual: "Location: {district}",
      locBannerChange: "change",
      locBannerOff: "Location off",
      locBannerPickTitle: "Search for the town or parish you're in:",
      locBannerSearchPlaceholder: "e.g. Sintra, Alfama…",
      locBannerNoResults: "No matches.",
      locBannerPickCancel: "Cancel",
      locBannerClear: "Turn off",
      // Deliberately names both possible causes: the page cannot tell a
      // site-level denial from OS location services being off (iOS reports
      // these inconsistently), and cannot fix either from here.
      locBannerFailed: "Couldn't get GPS — location may be off for this site, or for your browser in system settings. You can set a district manually instead.",
      locToastEnabled: "Location enabled.",
      locToastManualSet: "Location set to {district}.",
      locToastCleared: "Location turned off.",

      toastImportFailed: "Import failed: {msg}",
      "toastImported_one": "Imported {n} encounter.",
      "toastImported_other": "Imported {n} encounters.",

      mapEmptyState: "No encounters logged yet. Once you log one with location allowed, it appears here.",
      mapOutlineFailed: "Map outline failed to load ({msg}).",
      "mapNoLocationYet_one": "Your 1 encounter has no location data yet. Location is optional and only recorded if you allow it.",
      "mapNoLocationYet_other": "None of your {total} encounters have location data yet. Location is optional and only recorded if you allow it.",
      mapLegendTitle: "encounters per ~11 km cell",
      mapBusiestCells: "Busiest cells",
      "mapMissingLocation_one": "{missing} of {total} encounters has no location and isn't shown.",
      "mapMissingLocation_other": "{missing} of {total} encounters have no location and aren't shown.",
      "mapOutsidePortugal_one": "{n} encounter outside Portugal is not shown on this map.",
      "mapOutsidePortugal_other": "{n} encounters outside Portugal are not shown on this map.",
      mapCoordNote: "Positions are rounded to ~11 km at capture; exact coordinates are never stored.",
    },

    pt: {
      appTitle: "Encontros de Livros",
      appSubtitle: "registo de encontros com livros — piloto",

      navCapture: "Capturar",
      navLog: "Registo",
      navMap: "Mapa",
      navStats: "Estatísticas",

      btnScanBook: "Digitalizar livro",
      btnCapturePhoto: "Capturar foto",
      btnCancel: "Cancelar",
      btnSearch: "Pesquisar",
      btnLogAnyway: "Registar na mesma — sem necessidade de identificação",
      btnSaveEncounter: "Guardar encontro",
      btnExportJson: "Exportar JSON",
      btnImportJson: "Importar JSON",
      btnReject: "Rejeitar",
      btnEdit: "Editar",
      btnConfirm: "Confirmar",

      searchPlaceholder: "Pesquisar título ou autor…",
      locationNotePlaceholder: "ex.: Alfarrabista da Rua Anchieta",

      manualHeadingLog: "Registar este encontro",
      manualHeadingConfirm: "Confirmar detalhes",

      fieldTitle: "Título",
      fieldAuthor: "Autor",
      fieldPublisher: "Editora",
      fieldYear: "Ano",
      fieldPublished: "Publicação",
      fieldPages: "Páginas",
      fieldIsbn: "ISBN",
      fieldDepositoLegal: "Depósito Legal",
      fieldDetectedIsbn: "ISBN detetado",
      fieldDetectedDl: "Depósito Legal detetado",
      fieldContext: "Contexto",
      fieldLocationNote: "Nota de localização (opcional)",
      fieldNote: "Nota pessoal (opcional)",

      ctxShop: "loja",
      ctxLibrary: "biblioteca",
      ctxFriend: "amigo",
      ctxFair: "feira",
      ctxSecondhand: "alfarrabista",
      ctxOwned: "já possuía",
      ctxOther: "outro",

      rungBarcode: "Código de barras",
      rungIsbn: "ISBN impresso",
      rungDl: "Depósito Legal",
      rungTitleMatch: "Correspondência de título",
      rungManual: "Registado manualmente",

      filterAll: "todos",

      untitled: "(sem título)",
      noTitle: "(sem título)",
      unidentifiedEncounter: "Encontro não identificado",

      sourceNote: "Fonte: {source}. Dados de OCR/rede não são autoritativos — verifique antes de confirmar.",
      candidatesIntro: "Nenhum identificador exato encontrado. Candidatos ordenados a partir do texto da página de rosto (escolha um, ou rejeite para registar manualmente):",
      identifierNoMatch: "Identificador detetado mas sem correspondência no catálogo ou na rede:",
      suggestedFieldsIntro: "Sugestão a partir do texto da página (não verificado — confira antes de guardar):",
      catalogueGapBadge: "Não catalogado",
      stillLogByHand: "Pode registar na mesma — preencha o que souber manualmente.",
      noIdentifierFound: "Nenhum identificador encontrado nesta fotografia.",
      ocrTextSample: "Texto OCR (primeiros 200 carateres): {text}",

      logHeading: "Registo",
      noEncountersYet: "Ainda não há encontros registados.",

      mapHeading: "Mapa",
      statsHeading: "Estatísticas",
      statsRungDistribution: "Distribuição por patamar",
      statsByContext: "Por contexto",
      statTotalEncounters: "encontros no total",
      statDistinctEditions: "edições distintas",
      statUnidentified: "não identificados",
      statIdentified: "identificados",
      dexCompletionTitle: "Cobertura do catálogo",
      dexCompletionLine: "{count} de {total} livros catalogados pela BNP registados ({pct}%)",
      dexCompletionNote: "Livros que a BNP tinha catalogado em {date} — não todos os livros já publicados em Portugal. Ver o README para saber porquê.",
      dexCompletionUnavailable: "Dados de cobertura do catálogo indisponíveis.",
      discoveryGridTitle: "Grelha de descoberta (este dispositivo)",
      discoveryGridNote: "Cada quadrado representa {bucket} números de Depósito Legal consecutivos, do mais antigo (canto superior esquerdo) ao mais recente (canto inferior direito). A cor reflete quantos registou neste dispositivo — ainda não há dados partilhados entre utilizadores, por isso não é possível mostrar o que outros encontraram.",
      discoveryGridLess: "Menos",
      discoveryGridMore: "Mais",
      discoveryGridUnavailable: "Dados da grelha de descoberta indisponíveis.",
      noContextYet: "Ainda não há dados de contexto.",

      statusScanPrompt: "Aponte a um código de barras, ou toque em Capturar para fotografar a página.",
      statusCameraUnavailable: "Câmara indisponível: {msg}",
      statusReadingText: "A ler texto (pode demorar alguns segundos)…",
      statusTryingRotation: "A ler texto — esse ângulo não resultou, a tentar outra orientação ({i}/{total})…",
      statusSearching: "A pesquisar…",
      statusNoResults: "Sem resultados.",

      toastLookingUp: "A procurar {isbn}…",
      toastNotBookBarcode: "Não é um código de barras de livro (rejeitado): {raw}",
      toastCaptureFailed: "Falha na captura: {msg}",
      toastOcrFailed: "Falha no OCR: {msg} — pode registar na mesma manualmente.",
      toastEncounterSaved: "Encontro guardado.",
      toastEncounterSavedNoLocation: "Encontro guardado (sem localização: {reason}).",
      locationReasonDenied: "permissão negada",
      locationReasonTimeout: "expirou",
      locationReasonUnavailable: "indisponível",
      locationReasonUnsupported: "não suportado por este navegador",
      locationReasonNotEnabled: "não ativada",

      locBannerPrompt: "Adicionar localização aos seus encontros? Arredondada a ~11 km — a posição exata nunca é guardada.",
      locBannerEnable: "Usar GPS",
      locBannerSetManual: "Definir manualmente",
      locBannerActiveGps: "Localização: GPS",
      locBannerActiveManual: "Localização: {district}",
      locBannerChange: "alterar",
      locBannerOff: "Localização desligada",
      locBannerPickTitle: "Pesquise a localidade ou freguesia onde está:",
      locBannerSearchPlaceholder: "ex.: Sintra, Alfama…",
      locBannerNoResults: "Sem resultados.",
      locBannerPickCancel: "Cancelar",
      locBannerClear: "Desligar",
      locBannerFailed: "Não foi possível obter GPS — a localização pode estar desligada para este site, ou para o seu navegador nas definições do sistema. Pode definir um distrito manualmente.",
      locToastEnabled: "Localização ativada.",
      locToastManualSet: "Localização definida para {district}.",
      locToastCleared: "Localização desligada.",

      toastImportFailed: "Falha na importação: {msg}",
      "toastImported_one": "{n} encontro importado.",
      "toastImported_other": "{n} encontros importados.",

      mapEmptyState: "Ainda não há encontros registados. Assim que registar um com localização permitida, aparece aqui.",
      mapOutlineFailed: "Falha ao carregar o contorno do mapa ({msg}).",
      "mapNoLocationYet_one": "O seu único encontro ainda não tem dados de localização. A localização é opcional e só é registada se autorizada.",
      "mapNoLocationYet_other": "Nenhum dos seus {total} encontros tem dados de localização ainda. A localização é opcional e só é registada se autorizada.",
      mapLegendTitle: "encontros por célula de ~11 km",
      mapBusiestCells: "Células com mais encontros",
      "mapMissingLocation_one": "{missing} de {total} encontros não tem localização e não é apresentado.",
      "mapMissingLocation_other": "{missing} de {total} encontros não têm localização e não são apresentados.",
      "mapOutsidePortugal_one": "{n} encontro fora de Portugal não é apresentado neste mapa.",
      "mapOutsidePortugal_other": "{n} encontros fora de Portugal não são apresentados neste mapa.",
      mapCoordNote: "As posições são arredondadas a ~11 km no momento do registo; as coordenadas exatas nunca são guardadas.",
    },
  };

  function detectInitialLang() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "en" || stored === "pt") return stored;
    } catch (err) {
      // localStorage unavailable (private mode, etc.) — fall through to browser detection
    }
    const nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    return nav.startsWith("pt") ? "pt" : "en";
  }

  let lang = detectInitialLang();

  function interpolate(str, params) {
    if (!params) return str;
    return Object.keys(params).reduce(
      (s, k) => s.replace(new RegExp("\\{" + k + "\\}", "g"), params[k]),
      str
    );
  }

  function t(key, params) {
    const dict = DICTS[lang] || DICTS.en;
    const raw = key in dict ? dict[key] : key in DICTS.en ? DICTS.en[key] : key;
    return interpolate(raw, params);
  }

  // Picks key+"_one" when n===1, else key+"_other" — covers English and
  // Portuguese fine (both have a simple singular/plural split, no complex
  // plural categories like Slavic languages need).
  function tn(key, n, params) {
    const suffix = n === 1 ? "_one" : "_other";
    return t(key + suffix, Object.assign({ n }, params));
  }

  function getLang() {
    return lang;
  }

  function setLang(l) {
    const next = l === "pt" ? "pt" : "en";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch (err) {
      // ignore — language just won't persist across reloads
    }
    location.reload();
  }

  function applyStaticTranslations() {
    document.documentElement.lang = lang;
    document.title = t("appTitle");
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll(".lang-switch button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.lang === lang);
    });
  }

  return { t, tn, getLang, setLang, applyStaticTranslations, DICTS };
})();
