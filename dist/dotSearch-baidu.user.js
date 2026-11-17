// ==UserScript==
// @name         dotSearch for Baidu
// @version      0.5.0
// @description  增强搜索引擎用户体验的 UserScript（支持 Bing / Google / 百度）
// @author       AmeXE2
// @namespace    https://github.com/alt021/dotSearch
// @homepageURL  https://github.com/alt021/dotSearch
// @supportURL   https://github.com/alt021/dotSearch/issues
// @downloadURL  https://cdn.jsdelivr.net/gh/alt021/dotSearch@main/dist/dotSearch-baidu.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/alt021/dotSearch@main/dist/dotSearch-baidu.user.js
// @icon         https://cdn.jsdelivr.net/gh/alt021/dotSearch@main/assets/icon/dotsearch-baidu.svg
// @match        *://www.baidu.com/s*
// @match        *://baidu.com/s*
// @include      /^https?:\/\/(?:www\.)?baidu\.com\/(?:[?#]|index\.html(?:[?#]|$)|$)/
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// @noframes
// ==/UserScript==
"use strict";
(() => {
  // src/core/env.ts
  var PREFIX = "[dotSearch]", STYLE_ID = "search-enhance-styles", DEBUG_FLAG = "__searchEnhanceDebug__", log = {
    info(...args) {
      globalThis[DEBUG_FLAG] === !0 && console.info(PREFIX, ...args);
    },
    /** 关键诊断一律用 warn：Firefox 默认会显示，不依赖调试开关 */
    warn(...args) {
      console.warn(PREFIX, ...args);
    },
    error(...args) {
      console.error(PREFIX, ...args);
    }
  }, pendingStyles = /* @__PURE__ */ new Map();
  function injectStyle(css, id = STYLE_ID) {
    if (document.getElementById(id) || pendingStyles.has(id)) return;
    if (typeof GM_addStyle == "function")
      try {
        GM_addStyle(css);
        return;
      } catch {
      }
    let el = document.createElement("style");
    el.id = id, el.textContent = css;
    let host = document.head ?? document.documentElement;
    if (host) {
      host.appendChild(el);
      return;
    }
    pendingStyles.set(id, css);
    let observer3 = new MutationObserver(() => {
      let target = document.head ?? document.documentElement;
      target && (observer3.disconnect(), pendingStyles.delete(id), document.getElementById(id) || target.appendChild(el));
    });
    observer3.observe(document, { childList: !0, subtree: !0 });
  }

  // src/core/dom.ts
  function waitForSelector(selector, { timeout = 1e4, root = document } = {}) {
    let existing = root.querySelector(selector);
    return existing ? Promise.resolve(existing) : new Promise((resolve) => {
      let settled = !1, finish = (el) => {
        settled || (settled = !0, observer3.disconnect(), clearTimeout(timer2), resolve(el));
      }, observer3 = new MutationObserver(() => {
        let el = root.querySelector(selector);
        el && finish(el);
      });
      observer3.observe(root === document ? document : root, {
        childList: !0,
        subtree: !0
      });
      let timer2 = setTimeout(() => finish(null), timeout);
    });
  }
  function onUrlChange(handler) {
    let last = location.href, notify = () => {
      location.href !== last && (last = location.href, handler(new URL(location.href)));
    }, { pushState, replaceState } = history;
    return history.pushState = function(...args) {
      let result = pushState.apply(this, args);
      return queueMicrotask(notify), result;
    }, history.replaceState = function(...args) {
      let result = replaceState.apply(this, args);
      return queueMicrotask(notify), result;
    }, window.addEventListener("popstate", notify), window.addEventListener("hashchange", notify), () => {
      history.pushState = pushState, history.replaceState = replaceState, window.removeEventListener("popstate", notify), window.removeEventListener("hashchange", notify);
    };
  }
  function text(node) {
    return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  // src/engines/baidu.ts
  var BAIDU_HOSTS = ["www.baidu.com", "baidu.com"], INJECT_FLAG = "__searchEnhanceBaidu__", AD_SELECTORS = [
    "[data-tuiguang]",
    "[data-placeid]",
    ".ec_tuiguang",
    ".ec_adv",
    ".result-ad",
    ".bdbriwrapper-tuiguang"
  ], AD_SELECTOR = AD_SELECTORS.join(", ");
  function isBaiduHost(hostname) {
    return hostname === "www.baidu.com" || hostname === "baidu.com";
  }
  function isHttpUrl(value) {
    try {
      return /^https?:$/i.test(new URL(value).protocol);
    } catch {
      return !1;
    }
  }
  function resolveTarget(node, link) {
    let mu = node.getAttribute("mu")?.trim() ?? "";
    if (mu && isHttpUrl(mu) && !/^nourl\./i.test(new URL(mu).hostname))
      return mu;
    let raw = link.getAttribute("href")?.trim() ?? "";
    if (!raw || /^(#|javascript:)/i.test(raw)) return null;
    try {
      let absolute = new URL(raw, location.origin);
      return isHttpUrl(absolute.href) ? absolute.href : null;
    } catch {
      return null;
    }
  }
  function resolveDisplayUrl(node, target) {
    let source = text(
      node.querySelector('[class*="source-text"], .c-showurl, .siteLink_9TPP3')
    );
    try {
      let url = new URL(target);
      if (isBaiduHost(url.hostname) && (url.pathname === "/link" || url.pathname === "/baidu.php"))
        return source || url.hostname;
      let path = url.pathname === "/" ? "" : url.pathname;
      return `${url.protocol}//${url.host}${path}`;
    } catch {
      return source;
    }
  }
  function isAdNode(node) {
    return node.matches(AD_SELECTOR) || node.closest(AD_SELECTOR) !== null;
  }
  var SEARCH_INPUT_SELECTOR = '#chat-textarea, .chat-input-textarea, #kw, input[name="wd"], .s_ipt', SEARCH_SUBMIT_SELECTOR = '#chat-submit-button, #su, .s_btn, form#form input[type="submit"], form#form button[type="submit"]', homeSearchBound = !1, homeNavigating = !1;
  function isBaiduHome(url) {
    if (!isBaiduHost(url.hostname)) return !1;
    let path = url.pathname.replace(/\/+$/, "") || "/";
    return path === "/" || path === "/index.html";
  }
  function homeSearchInput() {
    let inputs = document.querySelectorAll(
      SEARCH_INPUT_SELECTOR
    );
    for (let input of inputs)
      if (input.offsetWidth > 0 || input.offsetHeight > 0 || input.getClientRects().length > 0)
        return input;
    return null;
  }
  function goToSearchResults() {
    if (homeNavigating) return !0;
    let keyword = homeSearchInput()?.value.trim() ?? "";
    if (!keyword) return !1;
    homeNavigating = !0;
    let target = new URL("/s", location.origin);
    return target.searchParams.set("wd", keyword), location.assign(target.href), !0;
  }
  function interceptHomeSearch(event) {
    goToSearchResults() && (event.preventDefault(), event.stopImmediatePropagation(), event.stopPropagation());
  }
  function bindHomeSearchBlock() {
    if (homeSearchBound) return;
    homeSearchBound = !0, document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter" || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        let target = event.target;
        !(target instanceof Element) || !target.closest(SEARCH_INPUT_SELECTOR) || interceptHomeSearch(event);
      },
      !0
    ), document.addEventListener(
      "submit",
      (event) => {
        let form = event.target;
        form instanceof HTMLFormElement && form.querySelector(SEARCH_INPUT_SELECTOR) && interceptHomeSearch(event);
      },
      !0
    );
    let onSearchButton = (event) => {
      event.target instanceof Element && event.target.closest(SEARCH_SUBMIT_SELECTOR) && interceptHomeSearch(event);
    };
    document.addEventListener(
      "pointerdown",
      (event) => {
        event.button === 0 && onSearchButton(event);
      },
      !0
    ), document.addEventListener("click", onSearchButton, !0);
  }
  var baidu = {
    id: "baidu",
    name: "百度",
    // 百度 Logo 的蓝色（#2529D8）；深色下提亮同色相保证对比度
    theme: { accent: "#2529d8", accentDark: "#7d83ff" },
    /*
     * 百度版菜单没有账户 / Rewards / 搜索设置等原站入口。
     * 保留的唯一功能是「附加设置」，因此菜单按钮直接打开该面板，
     * 不再先弹出一个只有一项的 popup。
     */
    directSettingsMenu: !0,
    hostnames: BAIDU_HOSTS,
    resultContainerSelector: "#content_left",
    resultItemSelector: "#content_left .result",
    searchForm: { path: "/s", param: "wd" },
    pagination: {
      param: "pn",
      offsetBase: 0,
      defaultSize: 10,
      sizeChoices: [10, 20, 50],
      hintSelector: '#page a[href*="pn="], .page a[href*="pn="], a[href*="pn="]',
      pageContainers: ["#page", ".page"]
    },
    isSearchPage(url) {
      let path = url.pathname.replace(/\/+$/, "") || "/";
      return isBaiduHost(url.hostname) && path === "/s";
    },
    parseQuery(url) {
      return url.searchParams.get("wd") ?? url.searchParams.get("word");
    },
    getAdSelectors() {
      return [...AD_SELECTORS];
    },
    onHomePage(url) {
      return isBaiduHome(url) ? (bindHomeSearchBlock(), !0) : !1;
    },
    extractResults(root) {
      let scope = root.querySelector("#content_left") ?? root, nodes = Array.from(scope.querySelectorAll(".result")), results = [];
      for (let node of nodes) {
        if (isAdNode(node)) continue;
        let heading = node.querySelector("h3"), link = heading?.querySelector("a[href]") ?? node.querySelector("h3 a[href]");
        if (!heading || !link) continue;
        let target = resolveTarget(node, link);
        target && results.push({
          node,
          link,
          title: text(heading),
          snippet: text(
            node.querySelector(
              '[class*="summary-text"], .c-abstract, [class*="content-right"], .c-span-last'
            )
          ),
          displayUrl: resolveDisplayUrl(node, target),
          url: target,
          index: results.length
        });
      }
      return results;
    },
    isAlreadyInjected(doc) {
      return INJECT_FLAG in doc;
    },
    markInjected(doc) {
      doc[INJECT_FLAG] = !0;
    },
    unmarkInjected(doc) {
      delete doc[INJECT_FLAG];
    }
    /*
     * 刻意不实现账户、站内功能入口与设置页折叠：
     * 百度版只保留「附加设置」，其余原站菜单入口不提供。
     */
  };

  // src/engines/index.ts
  var REGISTRY = [
    baidu
  ], activeEngines = REGISTRY;
  function detectEngine(url) {
    return activeEngines.find((engine3) => engine3.isSearchPage(url)) ?? null;
  }

  // src/features/filter-store.ts
  var STORAGE_KEY = "search-enhance:filter-rules", MULTI_LABEL_SUFFIXES = /* @__PURE__ */ new Set([
    "dpdns.org",
    "us.kg",
    "qzz.io",
    "xx.kg",
    "eu.org",
    "de5.net",
    "ggff.net",
    "finegear-sg.me",
    "eu.cc"
  ]);
  function normalizeDomain(input) {
    let value = input.trim().toLowerCase();
    if (!value || (value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""), value = value.split(/[/?#]/, 1)[0] ?? "", value = value.replace(/^[^@]*@/, "").replace(/:\d+$/, ""), !/^[a-z0-9.-]+$/.test(value)) || (value = value.replace(/^\.+|\.+$/g, ""), value.includes(".."))) return "";
    let parts = value.split(".");
    if (parts.length < 2) return "";
    let lastTwo = parts.slice(-2).join(".");
    return MULTI_LABEL_SUFFIXES.has(lastTwo) ? parts.length <= 3 ? parts.join(".") : parts.slice(-3).join(".") : parts.slice(-2).join(".");
  }
  function hasSharedStore() {
    return typeof GM_getValue == "function" && typeof GM_setValue == "function";
  }
  function readShared() {
    if (!hasSharedStore()) return { present: !1, raw: null };
    try {
      let value = GM_getValue(STORAGE_KEY, null);
      return value == null ? { present: !1, raw: null } : { present: !0, raw: typeof value == "string" ? value : JSON.stringify(value) };
    } catch {
      return { present: !1, raw: null };
    }
  }
  function writeShared(raw) {
    if (hasSharedStore())
      try {
        GM_setValue(STORAGE_KEY, raw);
      } catch {
      }
  }
  function readLocal() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }
  function writeLocal(raw) {
    try {
      localStorage.setItem(STORAGE_KEY, raw);
    } catch {
    }
  }
  function parseRules(raw) {
    if (!raw) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    let merged = /* @__PURE__ */ new Map();
    for (let value of parsed) {
      if (!value || typeof value != "object") continue;
      let r = value;
      if (typeof r.domain != "string" || r.action !== "badge" && r.action !== "hide") continue;
      let domain = normalizeDomain(r.domain);
      domain && merged.set(domain, r.action);
    }
    return [...merged].map(([domain, action]) => ({ domain, action }));
  }
  function getRules() {
    let shared = readShared();
    if (shared.present) return parseRules(shared.raw);
    let legacy = parseRules(readLocal());
    return legacy.length > 0 && writeShared(JSON.stringify(legacy)), legacy;
  }
  function setRules(rules) {
    let merged = /* @__PURE__ */ new Map();
    for (let rule of rules) {
      let domain = normalizeDomain(rule.domain);
      domain && merged.set(domain, rule.action === "hide" ? "hide" : "badge");
    }
    let raw = JSON.stringify([...merged].map(([domain, action]) => ({ domain, action })));
    writeShared(raw), writeLocal(raw);
  }
  function matchRule(url, rules) {
    if (!url) return null;
    let host = normalizeDomain(hostOf(url));
    if (!host) return null;
    let best = null;
    for (let rule of rules)
      rule.domain === host && (!best || rule.domain.length > best.domain.length) && (best = rule);
    return best;
  }
  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  // src/features/settings-store.ts
  var STORAGE_KEY2 = "search-enhance:settings", DEFAULTS = {
    privacy: !1,
    autoLoadMore: !1
  };
  function hasSharedStore2() {
    return typeof GM_getValue == "function" && typeof GM_setValue == "function";
  }
  function readShared2() {
    if (!hasSharedStore2()) return { present: !1, raw: null };
    try {
      let value = GM_getValue(STORAGE_KEY2, null);
      return value == null ? { present: !1, raw: null } : { present: !0, raw: typeof value == "string" ? value : JSON.stringify(value) };
    } catch {
      return { present: !1, raw: null };
    }
  }
  function writeShared2(raw) {
    if (hasSharedStore2())
      try {
        GM_setValue(STORAGE_KEY2, raw);
      } catch {
      }
  }
  function readLocal2() {
    try {
      return localStorage.getItem(STORAGE_KEY2);
    } catch {
      return null;
    }
  }
  function writeLocal2(raw) {
    try {
      localStorage.setItem(STORAGE_KEY2, raw);
    } catch {
    }
  }
  function parse(raw) {
    if (!raw) return {};
    try {
      let parsed = JSON.parse(raw);
      return !parsed || typeof parsed != "object" || Array.isArray(parsed) ? {} : parsed;
    } catch {
      return {};
    }
  }
  function normalize(raw) {
    return {
      privacy: typeof raw.privacy == "boolean" ? raw.privacy : DEFAULTS.privacy,
      autoLoadMore: typeof raw.autoLoadMore == "boolean" ? raw.autoLoadMore : DEFAULTS.autoLoadMore
    };
  }
  function getSettings() {
    let shared = readShared2();
    if (shared.present) return normalize(parse(shared.raw));
    let local = parse(readLocal2()), settings = normalize(local);
    return Object.keys(local).length > 0 && writeShared2(JSON.stringify(settings)), settings;
  }
  function setSetting(key, value) {
    let next = { ...getSettings(), [key]: value }, raw = JSON.stringify(next);
    writeShared2(raw), writeLocal2(raw);
  }
  function isPrivacyEnabled() {
    return getSettings().privacy;
  }
  function setPrivacyEnabled(enabled) {
    return setSetting("privacy", enabled), enabled;
  }
  function isAutoLoadMoreEnabled() {
    return getSettings().autoLoadMore;
  }
  function setAutoLoadMoreEnabled(enabled) {
    setSetting("autoLoadMore", enabled);
  }

  // src/features/privacy.ts
  var KEPT_PARAMS = /* @__PURE__ */ new Set([
    // 分页偏移（Bing first / Google start）：重写后的「加载更多」完全依赖它
    "first",
    "start",
    // 每页条数：若原地址指定了非默认值，丢掉会让页数与偏移的推算错位
    "count",
    // Google 每页条数（num=）
    "num",
    // Google 的界面语言 / 地区 / 网页模式：丢掉会悄悄换一套结果
    "hl",
    "gl",
    "udm"
  ]);
  function sanitizeSearchUrl(url, queryParam) {
    let clean = new URL(url.href), kept = /* @__PURE__ */ new Map(), query = clean.searchParams.get(queryParam);
    query !== null && kept.set(queryParam, query);
    for (let [key, value] of clean.searchParams)
      KEPT_PARAMS.has(key) && kept.set(key, value);
    for (let key of [...clean.searchParams.keys()]) clean.searchParams.delete(key);
    for (let [key, value] of kept) clean.searchParams.set(key, value);
    return clean.hash = "", clean;
  }
  function cleanAddressBar(queryParam) {
    let current = new URL(location.href), clean = sanitizeSearchUrl(current, queryParam);
    if (clean.href === current.href) return !1;
    try {
      return history.replaceState(history.state, "", clean.href), !0;
    } catch {
      return !1;
    }
  }

  // src/features/strip-to-results.ts
  var DEFAULT_PAGINATION = {
    param: "first",
    offsetBase: 1,
    defaultSize: 10,
    sizeChoices: [10, 20, 30, 50],
    hintSelector: 'a[href*="first="], .b_pag a, .sb_pagF a, .sb_pag a',
    pageContainers: [".b_pag", ".sb_pagF", ".sb_pag", "nav[aria-label]", 'nav[role="navigation"]']
  }, pagination = DEFAULT_PAGINATION;
  function isRelatedSearchBlock(el) {
    let classes = String(el.className ?? "").split(/\s+/);
    if (classes.includes("b_rs") || classes.includes("rsExplr")) return !0;
    let text2 = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    return /^(相关搜索|Related searches|人们还搜索了|其他人还搜了|People also search)/i.test(text2);
  }
  var ROOT_ID = "se-root", MENU_SLOT_CLASS = "se-menu-slot", SOURCE_ID = "se-source", LIST_ID = "se-list", lastSearchResults = [], MAX_PAGE_COUNT = 50, pageSize = DEFAULT_PAGINATION.defaultSize, pageNumber = 1, paginationBase = null, paginationQueryParam = "q", paginationMaxPage = 1, PAGINATION_UPDATED_EVENT = "dotsearch:pagination-updated", paginationObserver = null, paginationRefreshTimer = 0;
  function pageStartIndex() {
    return (pageNumber - 1) * pageSize;
  }
  function statText(total) {
    return `找到 ${total} 条结果`;
  }
  function rerenderResults() {
    let list = document.getElementById(LIST_ID);
    if (!list || lastSearchResults.length === 0) return !1;
    let rules = getRules();
    return list.textContent = "", list.append(...buildResultItems(lastSearchResults, pageStartIndex(), rules)), log.info(`已按 ${rules.length} 条过滤规则重建列表（含已加载的 ${lastSearchResults.length} 条）`), !0;
  }
  function appendResults(results) {
    let list = document.getElementById(LIST_ID);
    if (!list || results.length === 0) return lastSearchResults.length;
    let seen = new Set(lastSearchResults.map(resultKey)), fresh = results.filter((result) => {
      let key = resultKey(result);
      return key !== "" && seen.has(key) ? !1 : (key !== "" && seen.add(key), !0);
    });
    if (fresh.length === 0) return lastSearchResults.length;
    let start = pageStartIndex() + lastSearchResults.length;
    return list.append(...buildResultItems(fresh, start)), lastSearchResults = lastSearchResults.concat(fresh), updateResultCount(lastSearchResults.length), lastSearchResults.length;
  }
  function resultKey(result) {
    return result.url ?? result.link?.href ?? "";
  }
  function getLoadedResultCount() {
    return lastSearchResults.length;
  }
  function clipOriginalContent() {
    let source = document.createElement("div");
    for (source.id = SOURCE_ID, source.className = "se-source", source.setAttribute("aria-hidden", "true"), source.toggleAttribute("inert", !0); document.body.firstChild; ) source.appendChild(document.body.firstChild);
    return document.body.appendChild(source), source;
  }
  var stripToResults = {
    id: "strip-to-results",
    name: "重写结果页",
    description: "移除顶栏、页脚、侧栏、广告与原站样式，用统一结构重建结果列表。",
    engines: "all",
    supports() {
      return !0;
    },
    dispose() {
      stopWatchingPagination();
    },
    async onNavigate({ engine: engine3, query }) {
      if (document.getElementById(ROOT_ID)) {
        log.info("页面已重写且状态完整，跳过");
        return;
      }
      let before = document.body.querySelectorAll("*").length, container2 = document.querySelector(engine3.resultContainerSelector);
      if (!container2) {
        log.warn(`结果容器未找到（${engine3.resultContainerSelector}），无法重写`);
        return;
      }
      await waitForPagination(engine3.pagination?.hintSelector, 1e3);
      let results = engine3.extractResults(container2);
      resolvePagination(engine3, results.length);
      let answerSelector = engine3.answerNodeSelector, answerNodes = answerSelector ? Array.from(document.querySelectorAll(answerSelector)).filter(
        (node) => pruneAnswerNode(node)
      ) : [], root = document.createElement("div");
      root.id = ROOT_ID, root.dataset.query = query, root.appendChild(buildMasthead(query, results.length, engine3));
      let main = document.createElement("main");
      main.className = "se-main";
      for (let node of answerNodes)
        node.classList.add("se-extra"), main.appendChild(node);
      results.length > 0 ? (lastSearchResults = results, main.appendChild(buildResultList(results))) : main.appendChild(buildEmptyState(query)), root.appendChild(main), engine3.captureSession?.();
      let source = clipOriginalContent();
      document.body.className = "se-stripped", document.body.removeAttribute("style"), document.documentElement.removeAttribute("style"), document.documentElement.className = "se-root-html", document.body.appendChild(root), watchSourcePagination(source), bindHiddenToggle(root);
      let style = document.createElement("style");
      style.id = "se-rewrite-style", style.textContent = "html.se-root-html { height: auto; font-size: 16px !important; }", document.head.appendChild(style);
      let after = document.body.querySelectorAll("*").length, hidden = source.querySelectorAll("*").length;
      log.warn(
        `[重写完成] DOM ${before} → ${after}（其中隐藏数据源 ${hidden} 个节点），结果 ${results.length} 条（${lastPaginationDebug}）`
      ), isPrivacyEnabled() && cleanAddressBar(engine3.searchForm.param) && log.info("净化链接：已去掉地址栏中的追踪参数");
    }
  };
  function buildMasthead(query, count, engine3) {
    let head = document.createElement("header");
    head.className = "se-masthead";
    let brand = document.createElement("p");
    brand.className = "se-brand";
    let mark = document.createElement("span");
    mark.className = "se-mark", mark.setAttribute("aria-hidden", "true"), brand.append(mark, document.createTextNode(`${engine3.name} — 检索`));
    let brandRow = document.createElement("div");
    brandRow.className = "se-brand-row";
    let menuSlot = document.createElement("div");
    menuSlot.className = MENU_SLOT_CLASS, brandRow.append(brand, menuSlot), head.appendChild(brandRow);
    let form = document.createElement("form");
    form.className = "se-query-form", form.setAttribute("role", "search");
    let input = document.createElement("input");
    input.type = "search", input.className = "se-query", input.value = query, input.setAttribute("aria-label", "搜索关键词"), input.spellcheck = !1, input.autocomplete = "off", input.addEventListener("blur", () => input.setSelectionRange(0, 0));
    let stat = document.createElement("p");
    return stat.className = "se-stat", stat.dataset.count = String(count), stat.textContent = statText(count), form.append(input, stat), form.addEventListener("submit", (event) => {
      event.preventDefault();
      let keyword = input.value.trim();
      if (!keyword || keyword === query) return;
      let { path, param } = engine3.searchForm;
      window.location.assign(
        `${window.location.origin}${path}?${param}=${encodeURIComponent(keyword)}`
      );
    }), input.addEventListener("focus", () => {
      stat.textContent = "按回车键发起搜索";
    }), input.addEventListener("blur", () => {
      input.value = query, stat.textContent = statText(Number(stat.dataset.count ?? count));
    }), head.appendChild(form), head;
  }
  function updateResultCount(total) {
    let stat = document.querySelector(".se-stat");
    stat && (stat.dataset.count = String(total), document.activeElement?.classList.contains("se-query") || (stat.textContent = statText(total)));
  }
  function buildResultList(results) {
    let list = document.createElement("ol");
    return list.className = "se-list", list.id = LIST_ID, list.append(...buildResultItems(results, pageStartIndex())), list;
  }
  function buildResultItems(results, startIndex, rules = getRules()) {
    return results.map((result, offset) => {
      let item = document.createElement("li");
      item.className = "se-item";
      let href = result.url ?? result.link?.href, num = document.createElement("span");
      num.className = "se-num", num.textContent = String(startIndex + offset + 1).padStart(2, "0");
      let body = document.createElement("div");
      if (body.className = "se-body", result.displayUrl) {
        let cite = document.createElement("cite");
        cite.className = "se-cite", cite.textContent = result.displayUrl, href && (cite.title = href), body.appendChild(cite);
      }
      let heading = document.createElement("h2");
      heading.className = "se-title";
      let hitRule = matchRule(href, rules);
      hitRule?.action === "badge" && heading.appendChild(buildFilterTag());
      let anchor = document.createElement("a");
      if (anchor.className = "se-link", anchor.textContent = result.title || result.displayUrl || "(无标题)", applyLinkAttrs(anchor, href), heading.appendChild(anchor), body.appendChild(heading), result.snippet) {
        let desc = document.createElement("p");
        desc.className = "se-snippet", desc.textContent = result.snippet, body.appendChild(desc);
      }
      let hit = document.createElement("a");
      return hit.className = "se-hit", hit.setAttribute("aria-hidden", "true"), hit.tabIndex = -1, applyLinkAttrs(hit, href), item.append(num, hit, body), href && (item.dataset.seHref = href), hitRule?.action === "hide" && (item.classList.add("se-item-hidden"), hit.removeAttribute("href"), hideItemBody(body)), item;
    });
  }
  function hideItemBody(body) {
    if (body.dataset.seHidden) return;
    body.dataset.seHidden = "1";
    let stash = document.createElement("div");
    for (; body.firstChild; ) stash.appendChild(body.firstChild);
    body.__seStash = stash;
    let placeholder = document.createElement("p");
    placeholder.className = "se-tag se-tag-hidden", placeholder.textContent = "该结果已隐藏", body.appendChild(placeholder);
  }
  function restoreItemBody(body) {
    if (!body.dataset.seHidden) return;
    delete body.dataset.seHidden;
    let stash = body.__seStash;
    if (stash) {
      for (body.textContent = ""; stash.firstChild; ) body.appendChild(stash.firstChild);
      delete body.__seStash;
      return;
    }
    body.textContent = "";
  }
  function buildFilterTag() {
    let tag = document.createElement("span");
    return tag.className = "se-tag se-tag-excluded", tag.textContent = "已排除", tag.setAttribute("aria-hidden", "true"), tag;
  }
  var TOGGLE_BOUND = "__seFilterToggleBound__";
  function bindHiddenToggle(root) {
    let flag = root;
    flag[TOGGLE_BOUND] || (flag[TOGGLE_BOUND] = !0, root.addEventListener(
      "mousedown",
      (event) => {
        event.target?.closest(".se-item-hidden") && event.preventDefault();
      },
      !0
    ), root.addEventListener(
      "click",
      (event) => {
        let target = event.target;
        if (target?.closest("a.se-link, a.se-hit[href]")) return;
        let item = target?.closest(".se-item-hidden");
        item && (event.preventDefault(), revealItem(item));
      },
      // 捕获阶段：占位条的覆盖锚点虽被移除了 href，仍可能吞掉事件
      !0
    ));
  }
  function revealItem(item) {
    let body = item.querySelector(".se-body"), href = item.dataset.seHref;
    if (!body) return;
    item.classList.remove("se-item-hidden"), restoreItemBody(body);
    let hit = item.querySelector(".se-hit");
    hit && href && applyLinkAttrs(hit, href), log.info("已解除隐藏：", item.dataset.seHref);
  }
  function applyLinkAttrs(anchor, href) {
    href && (anchor.href = href, anchor.target = "_blank", anchor.rel = "noopener noreferrer");
  }
  function offsetPattern(param, flags = "g") {
    let escaped = param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`[?&]${escaped}=(\\d+)`, flags);
  }
  function waitForPagination(hintSelector, timeout) {
    return !hintSelector || document.querySelector(hintSelector) ? Promise.resolve() : new Promise((resolve) => {
      let settled = !1, timer2 = 0, observer3 = new MutationObserver(() => {
        document.querySelector(hintSelector) && finish();
      });
      function finish() {
        settled || (settled = !0, observer3.disconnect(), window.clearTimeout(timer2), resolve());
      }
      timer2 = window.setTimeout(finish, timeout), observer3.observe(document.documentElement, { childList: !0, subtree: !0 });
    });
  }
  function collectPageOffsets(root = document) {
    let offsets = /* @__PURE__ */ new Set(), pattern = offsetPattern(pagination.param), scan = (raw) => {
      pattern.lastIndex = 0;
      let m;
      for (; m = pattern.exec(raw); ) {
        let n = Number(m[1]);
        Number.isFinite(n) && offsets.add(n);
      }
    };
    for (let a of root.querySelectorAll("a[href]"))
      scan(a.getAttribute("href") ?? "");
    return offsets.size === 0 && scan(root instanceof Element ? root.innerHTML : document.documentElement.innerHTML), [...offsets].filter((n) => n >= pagination.offsetBase).sort((a, b) => a - b);
  }
  function detectPageSize(offsets, sizeHint = 0) {
    if (sizeHint > 0) {
      let snapped = snapPageSize(sizeHint);
      if (offsets.length === 0 || offsets.every((offset) => offsetAligns(offset, snapped)))
        return snapped;
    }
    let diffs = [];
    for (let i = 1; i < offsets.length; i++) {
      let prev = offsets[i - 1], cur = offsets[i];
      if (prev === void 0 || cur === void 0) continue;
      let d = cur - prev;
      d > 0 && diffs.push(d);
    }
    return diffs.length > 0 ? Math.min(...diffs) : sizeHint > 0 ? snapPageSize(sizeHint) : pagination.defaultSize;
  }
  function offsetAligns(offset, size) {
    return (offset - pagination.offsetBase) % size === 0 || offset % size === 0;
  }
  function snapPageSize(sizeHint) {
    return pagination.sizeChoices.find((n) => n >= sizeHint) ?? sizeHint;
  }
  function currentPageNumber(size) {
    let raw = new URL(location.href).searchParams.get(pagination.param);
    if (raw === null) return 1;
    let offset = Number(raw);
    return Number.isFinite(offset) ? offsetToPage(offset, size) : 1;
  }
  function offsetToPage(offset, pageSize2) {
    return Math.floor(offset / pageSize2) + 1;
  }
  function pageToOffset(page, pageSize2) {
    return (page - 1) * pageSize2 + pagination.offsetBase;
  }
  function collectRenderedPageNumbers(root = document) {
    let nums = /* @__PURE__ */ new Set();
    for (let a of root.querySelectorAll("a")) {
      let href = a.getAttribute("href") ?? "", text2 = (a.textContent ?? "").trim(), aria = (a.getAttribute("aria-label") ?? "").trim(), numText;
      if (/^\d{1,3}$/.test(text2) ? numText = text2 : numText = (aria.match(/^第\s*(\d{1,3})\s*页$/) ?? aria.match(/^Page\s*(\d{1,3})$/i))?.[1], !numText || !(offsetPattern(pagination.param).test(href) || a.closest(pagination.pageContainers.join(", ")) !== null)) continue;
      let n = Number(numText);
      n >= 1 && n <= 999 && nums.add(n);
    }
    return [...nums].sort((a, b) => a - b);
  }
  function buildPageHref(base, page, pageSize2, queryParam) {
    let source = isPrivacyEnabled() ? sanitizeSearchUrl(base, queryParam) : new URL(base.href), url = new URL(source.href);
    return page <= 1 ? url.searchParams.delete(pagination.param) : url.searchParams.set(pagination.param, String(pageToOffset(page, pageSize2))), url.href;
  }
  var lastPaginationDebug = "";
  function collectNumericPageHints(root = document) {
    let nums = /* @__PURE__ */ new Set(), scopes = root.querySelectorAll(pagination.pageContainers.join(", "));
    for (let scope of scopes)
      for (let el of scope.querySelectorAll("a, span, div, li")) {
        let t = (el.textContent ?? "").trim();
        /^\d{1,3}$/.test(t) && nums.add(Number(t));
      }
    return [...nums];
  }
  function readPaginationHints(root = document) {
    let offsets = collectPageOffsets(root), rendered = collectRenderedPageNumbers(root), fromOffsets = offsets.length > 0 ? offsetToPage(Math.max(...offsets), pageSize) : 0, numericHints = rendered.length > 0 || fromOffsets > 0 ? [] : collectNumericPageHints(root);
    return {
      rendered,
      offsets,
      max: Math.max(
        rendered.length > 0 ? Math.max(...rendered) : 0,
        fromOffsets,
        numericHints.length > 0 ? Math.max(...numericHints) : 0
      )
    };
  }
  function resolvePagination(engine3, sizeHint = 0) {
    pagination = engine3.pagination ?? DEFAULT_PAGINATION, paginationQueryParam = engine3.searchForm.param;
    let offsets = collectPageOffsets();
    pageSize = detectPageSize(offsets, sizeHint);
    let base = new URL(location.href), current = currentPageNumber(pageSize);
    pageNumber = current, paginationBase = base;
    let hints = readPaginationHints();
    paginationMaxPage = Math.min(Math.max(current, hints.max), MAX_PAGE_COUNT), lastPaginationDebug = hints.max === 0 ? `每页${pageSize}条 当前第${current}页 无后续页线索` : `页码[${hints.rendered.join(",") || "-"}] 偏移[${hints.offsets.join(",") || "-"}] 每页${pageSize}条 当前第${current}页 总${paginationMaxPage}页`;
  }
  function getPaginationState() {
    return { pageSize, pageNumber, maxPage: paginationMaxPage };
  }
  function buildPageUrl(page) {
    let base = paginationBase ?? new URL(location.href);
    return buildPageHref(base, page, pageSize, paginationQueryParam);
  }
  function watchSourcePagination(source) {
    stopWatchingPagination(), paginationObserver = new MutationObserver(schedulePaginationRefresh), paginationObserver.observe(source, {
      childList: !0,
      subtree: !0,
      attributes: !0,
      attributeFilter: ["href"],
      characterData: !0
    }), schedulePaginationRefresh();
  }
  function schedulePaginationRefresh() {
    paginationRefreshTimer || (paginationRefreshTimer = window.setTimeout(() => {
      paginationRefreshTimer = 0, refreshPagination();
    }, 250));
  }
  function stopWatchingPagination() {
    paginationObserver?.disconnect(), paginationObserver = null, paginationRefreshTimer && (window.clearTimeout(paginationRefreshTimer), paginationRefreshTimer = 0);
  }
  function refreshPagination() {
    let source = document.getElementById(SOURCE_ID);
    if (!source || !document.getElementById(ROOT_ID)) return;
    let max = Math.min(readPaginationHints(source).max, MAX_PAGE_COUNT);
    if (max <= paginationMaxPage) return;
    let previous = paginationMaxPage;
    paginationMaxPage = max, log.info(`[分页补齐] 原站分页稍后渲染：总页数 ${previous} → ${max}`), document.dispatchEvent(new CustomEvent(PAGINATION_UPDATED_EVENT));
  }
  function buildEmptyState(query) {
    let empty = document.createElement("p");
    return empty.className = "se-empty", empty.textContent = `没有找到与「${query}」相关的结果。`, empty;
  }
  function pruneAnswerNode(node) {
    if (isRelatedSearchBlock(node)) return !1;
    for (let el of Array.from(node.querySelectorAll("*")))
      isRelatedSearchBlock(el) && el.remove();
    for (let el of Array.from(node.querySelectorAll("style, link"))) el.remove();
    return stripComplianceLinks(node), (node.textContent ?? "").replace(/\s+/g, " ").trim().length >= 10;
  }
  var COMPLIANCE_PATTERN = /隐私|条款|条款|协议|备案|许可|版权|法律|声明|政策|服务条款|隐私政策|隐私声明|京 ICP|沪 ICP|粤 ICP|ICP 备|公网安备|copyright|privacy|terms|legal|cookie/i;
  function stripComplianceLinks(root) {
    root.querySelectorAll("a[href]").forEach((a) => {
      let text2 = (a.textContent ?? "").replace(/\s+/g, " ").trim(), href = a.getAttribute("href") ?? "";
      (COMPLIANCE_PATTERN.test(text2) || COMPLIANCE_PATTERN.test(href)) && (a.closest("li, p, div") ?? a).remove();
    });
  }

  // src/features/filter-panel.ts
  var FILTER_PANEL_CLASS = "se-filter-panel", ACTIONS = [
    { value: "badge", label: "加「已排除」标签" },
    { value: "hide", label: "隐藏该结果" }
  ];
  function openFilterPanel(onApply) {
    if (document.querySelector(`.${FILTER_PANEL_CLASS}`)) return;
    let overlay = document.createElement("div");
    overlay.className = "se-filter-overlay";
    let panel = document.createElement("div");
    panel.className = FILTER_PANEL_CLASS, panel.setAttribute("role", "dialog"), panel.setAttribute("aria-modal", "true"), panel.setAttribute("aria-label", "结果过滤设置");
    let head = document.createElement("div");
    head.className = "se-filter-head";
    let title = document.createElement("h2");
    title.className = "se-filter-title", title.textContent = "结果过滤";
    let close = document.createElement("button");
    close.type = "button", close.className = "se-filter-close", close.setAttribute("aria-label", "关闭结果过滤设置"), close.title = "关闭";
    let closeGlyph = document.createElement("span");
    closeGlyph.setAttribute("aria-hidden", "true"), closeGlyph.textContent = "×", close.appendChild(closeGlyph), head.append(title, close);
    let rows = document.createElement("div");
    rows.className = "se-filter-rows";
    let render = () => {
      rows.textContent = "";
      let rules = getRules();
      if (rules.length === 0) {
        let empty = document.createElement("p");
        empty.className = "se-filter-empty", empty.textContent = "- EMPTY -", rows.appendChild(empty);
        return;
      }
      rules.forEach((rule, i) => rows.appendChild(buildRow(rule, i, commit)));
    }, commit = () => {
      let next = [...rows.querySelectorAll(".se-filter-row")].map((row) => ({
        domain: row.querySelector(".se-filter-domain")?.value ?? "",
        action: row.querySelector(".se-filter-action")?.value ?? "badge"
      })).filter((r) => normalizeDomain(r.domain));
      setRules(next), render(), onApply();
    }, addWrap = document.createElement("div");
    addWrap.className = "se-filter-add";
    let domainInput = document.createElement("input");
    domainInput.type = "text", domainInput.className = "se-filter-input", domainInput.placeholder = "example.com", domainInput.setAttribute("aria-label", "要过滤的域名");
    let actionSelect = document.createElement("select");
    actionSelect.className = "se-filter-select", actionSelect.setAttribute("aria-label", "对该域名的处理方式");
    for (let a of ACTIONS) {
      let opt = document.createElement("option");
      opt.value = a.value, opt.textContent = a.label, actionSelect.appendChild(opt);
    }
    let addBtn = document.createElement("button");
    addBtn.type = "button", addBtn.className = "se-filter-add-btn", addBtn.textContent = "添加";
    let add = () => {
      let domain = normalizeDomain(domainInput.value);
      if (!domain) {
        domainInput.classList.add("se-filter-input-invalid"), domainInput.focus();
        return;
      }
      let rules = getRules(), existing = rules.findIndex((r) => r.domain === domain), action = actionSelect.value;
      existing >= 0 ? rules[existing] = { domain, action } : rules.push({ domain, action }), setRules(rules), domainInput.value = "", domainInput.classList.remove("se-filter-input-invalid"), render(), onApply(), domainInput.focus();
    };
    addBtn.addEventListener("click", add), domainInput.addEventListener("keydown", (e) => {
      e.key === "Enter" && (e.preventDefault(), add());
    }), domainInput.addEventListener("input", () => domainInput.classList.remove("se-filter-input-invalid")), addWrap.append(domainInput, actionSelect, addBtn), panel.append(head, rows, addWrap), overlay.appendChild(panel), (document.getElementById(ROOT_ID) ?? document.body).appendChild(overlay), render();
    let onClose = () => {
      overlay.remove(), document.removeEventListener("keydown", onKey);
    }, onKey = (e) => {
      e.key === "Escape" && onClose();
    };
    close.addEventListener("click", onClose), overlay.addEventListener("click", (e) => {
      e.target === overlay && onClose();
    }), document.addEventListener("keydown", onKey), domainInput.focus();
  }
  function buildRow(rule, index, commit) {
    let row = document.createElement("div");
    row.className = "se-filter-row";
    let domain = document.createElement("input");
    domain.type = "text", domain.className = "se-filter-domain", domain.value = rule.domain, domain.setAttribute("aria-label", `第 ${index + 1} 条规则的域名`), domain.addEventListener("change", commit);
    let action = document.createElement("select");
    action.className = "se-filter-action", action.setAttribute("aria-label", `第 ${index + 1} 条规则的处理方式`);
    for (let a of ACTIONS) {
      let opt = document.createElement("option");
      opt.value = a.value, opt.textContent = a.label, action.appendChild(opt);
    }
    action.value = rule.action, action.addEventListener("change", commit);
    let remove = document.createElement("button");
    return remove.type = "button", remove.className = "se-filter-remove", remove.textContent = "删除", remove.setAttribute("aria-label", `删除 ${rule.domain} 的规则`), remove.addEventListener("click", () => {
      row.remove(), commit();
    }), row.append(domain, action, remove), row;
  }

  // src/features/load-more.ts
  var MORE_CLASS = "se-more", MORE_BUTTON_CLASS = "se-more-button", MAX_TOTAL_RESULTS = 100, LABEL = "SHOW MORE", LOADING_LABEL = "LOADING…", VIEWPORT_MARGIN = 300, engine = null, container = null, button = null, observer = null, paginationListener = null, controller = null, autoTimer = 0, nextPage = 2, loading = !1, hasMore = !1, exhausted = !1, loadMore = {
    id: "load-more",
    name: "加载更多",
    description: "在结果列表末尾追加下一页结果，不再跳转页码。",
    /*
     * 分页偏移参数由引擎适配器的 PaginationConfig 提供：
     * Bing 是 first=（1 起），Google 是 start=（0 起），百度是 pn=（0 起）。
     * 接入拼页的引擎都已实现 buildPageUrl；接新引擎时先补 pagination 配置再放开这里。
     */
    engines: ["bing", "google", "baidu"],
    supports() {
      return !0;
    },
    onNavigate(ctx) {
      teardown();
      let list = document.getElementById(LIST_ID);
      if (!list) return;
      engine = ctx.engine;
      let state = getPaginationState();
      nextPage = state.pageNumber + 1;
      let total = getLoadedResultCount();
      hasMore = total > 0 && total < MAX_TOTAL_RESULTS, hasMore &&= state.maxPage > state.pageNumber || total >= state.pageSize, mount(list), syncVisibility(), bindPaginationUpdates();
    },
    dispose() {
      teardown();
    }
  };
  function mount(list) {
    container = document.createElement("div"), container.className = MORE_CLASS, button = document.createElement("button"), button.type = "button", button.className = MORE_BUTTON_CLASS, button.textContent = LABEL, button.setAttribute("aria-label", "加载更多结果"), button.addEventListener("click", () => void requestNextPage()), container.appendChild(button), list.after(container), setupObserver();
  }
  function setupObserver() {
    !button || typeof IntersectionObserver > "u" || (observer?.disconnect(), observer = new IntersectionObserver(
      (entries) => {
        entries.some((entry) => entry.isIntersecting) && isAutoLoadMoreEnabled() && requestNextPage();
      },
      { rootMargin: `0px 0px ${VIEWPORT_MARGIN}px 0px` }
    ), observer.observe(button));
  }
  function bindPaginationUpdates() {
    paginationListener = () => {
      exhausted || getLoadedResultCount() >= MAX_TOTAL_RESULTS || (hasMore = !0, syncVisibility(), kickAuto());
    }, document.addEventListener(PAGINATION_UPDATED_EVENT, paginationListener);
  }
  function refreshAutoLoad() {
    !button || !hasMore || kickAuto();
  }
  function kickAuto() {
    !isAutoLoadMoreEnabled() || !hasMore || loading || (window.clearTimeout(autoTimer), autoTimer = window.setTimeout(() => {
      autoTimer = 0, !(!button || !button.isConnected || !hasMore) && isAutoLoadMoreEnabled() && inViewport(button) && requestNextPage();
    }, 200));
  }
  function inViewport(el) {
    let rect = el.getBoundingClientRect();
    return rect.top < window.innerHeight + VIEWPORT_MARGIN && rect.bottom > -VIEWPORT_MARGIN;
  }
  async function requestNextPage() {
    if (loading || !hasMore || exhausted || !engine) return;
    let before = getLoadedResultCount();
    if (before >= MAX_TOTAL_RESULTS) {
      stopLoading("已达到单次检索上限"), syncVisibility();
      return;
    }
    loading = !0, setBusy(!0);
    try {
      let url = buildPageUrl(nextPage);
      controller = new AbortController();
      let response = await fetch(url, {
        credentials: "same-origin",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      let html = await response.text(), doc = new DOMParser().parseFromString(html, "text/html"), base = doc.createElement("base");
      base.href = url, (doc.head ?? doc.documentElement).prepend(base);
      let remaining = MAX_TOTAL_RESULTS - before, results = engine.extractResults(doc).slice(0, Math.max(0, remaining)), after = appendResults(results);
      nextPage += 1, after <= before ? stopLoading("没有更多结果") : after >= MAX_TOTAL_RESULTS ? stopLoading(`已达到单次检索上限（${MAX_TOTAL_RESULTS} 条）`) : (hasMore = !0, log.info(`[加载更多] 第 ${nextPage - 1} 页：追加 ${after - before} 条，累计 ${after} 条`));
    } catch (err) {
      err.name !== "AbortError" && log.warn("[加载更多] 抓取失败：", err);
    } finally {
      controller = null, loading = !1, setBusy(!1), syncVisibility(), kickAuto();
    }
  }
  function stopLoading(reason) {
    hasMore = !1, exhausted = !0, log.info(`[加载更多] ${reason}`);
  }
  function setBusy(busy) {
    button && (button.disabled = busy, button.setAttribute("aria-busy", String(busy)), button.textContent = busy ? LOADING_LABEL : LABEL);
  }
  function syncVisibility() {
    container && (container.hidden = !hasMore, hasMore && button && (button.disabled = loading, button.textContent = loading ? LOADING_LABEL : LABEL));
  }
  function teardown() {
    observer?.disconnect(), observer = null, window.clearTimeout(autoTimer), autoTimer = 0, controller?.abort(), controller = null, paginationListener && (document.removeEventListener(PAGINATION_UPDATED_EVENT, paginationListener), paginationListener = null), container?.remove(), container = null, button = null, engine = null, loading = !1, hasMore = !1, exhausted = !1, nextPage = 2;
  }

  // src/features/settings-panel.ts
  var SETTINGS_PANEL_CLASS = "se-settings-panel", OVERLAY_CLASS = "se-settings-overlay", PRIVACY_TOGGLE_CLASS = "se-privacy-toggle", AUTO_MORE_TOGGLE_CLASS = "se-auto-more-toggle", FILTER_GOTO_CLASS = "se-settings-goto";
  function openSettingsPanel({ engine: engine3 }) {
    if (document.querySelector(`.${SETTINGS_PANEL_CLASS}`)) return;
    let overlay = document.createElement("div");
    overlay.className = `${OVERLAY_CLASS} se-filter-overlay`;
    let panel = document.createElement("div");
    panel.className = SETTINGS_PANEL_CLASS, panel.setAttribute("role", "dialog"), panel.setAttribute("aria-modal", "true"), panel.setAttribute("aria-label", "附加设置");
    let head = document.createElement("div");
    head.className = "se-settings-head";
    let title = document.createElement("h2");
    title.className = "se-settings-title", title.textContent = "附加设置";
    let close = document.createElement("button");
    close.type = "button", close.className = "se-settings-close", close.setAttribute("aria-label", "关闭附加设置"), close.title = "关闭";
    let glyph = document.createElement("span");
    glyph.setAttribute("aria-hidden", "true"), glyph.textContent = "×", close.appendChild(glyph), head.append(title, close);
    let rows = document.createElement("div");
    rows.className = "se-settings-rows", rows.append(buildFilterRow(), buildAutoLoadRow(), buildPrivacyRow(engine3));
    let tail = document.createElement("div");
    tail.className = "se-settings-tail", panel.append(head, rows, tail), overlay.appendChild(panel), (document.getElementById(ROOT_ID) ?? document.body).appendChild(overlay);
    let onClose = () => {
      overlay.remove(), document.removeEventListener("keydown", onKey);
    }, onKey = (event) => {
      event.key === "Escape" && onClose();
    };
    close.addEventListener("click", onClose), overlay.addEventListener("click", (event) => {
      event.target === overlay && onClose();
    }), document.addEventListener("keydown", onKey);
  }
  function buildFilterRow() {
    let row = document.createElement("div");
    row.className = "se-settings-row se-settings-row-stacked";
    let head = document.createElement("div");
    head.className = "se-settings-row-head";
    let label = document.createElement("span");
    label.className = "se-settings-label", label.textContent = "结果过滤设置";
    let go = document.createElement("button");
    go.type = "button", go.className = `se-settings-action ${FILTER_GOTO_CLASS}`, go.textContent = "进入", go.setAttribute("aria-label", "进入结果过滤设置"), go.addEventListener("click", () => {
      openFilterPanel(() => {
        rerenderResults() || log.warn("未找到结果列表，过滤改动将在下次重写后生效");
      });
    });
    let hint = document.createElement("p");
    return hint.className = "se-settings-hint", hint.textContent = "屏蔽指定网站的搜索结果。", head.append(label, go), row.append(head, hint), row;
  }
  function buildAutoLoadRow() {
    let row = document.createElement("div");
    row.className = "se-settings-row se-settings-row-stacked";
    let head = document.createElement("div");
    head.className = "se-settings-row-head";
    let label = document.createElement("span");
    label.className = "se-settings-label", label.textContent = "自动加载更多结果";
    let enabled = getSettings().autoLoadMore, toggle = document.createElement("button");
    toggle.type = "button", toggle.className = `se-settings-switch ${AUTO_MORE_TOGGLE_CLASS}`, toggle.setAttribute("role", "switch"), toggle.setAttribute("aria-checked", String(enabled)), toggle.setAttribute("aria-label", "自动加载更多结果"), toggle.classList.toggle("se-settings-switch-on", enabled);
    let knob = document.createElement("span");
    knob.className = "se-settings-knob", knob.setAttribute("aria-hidden", "true"), toggle.appendChild(knob), head.append(label, toggle);
    let hint = document.createElement("p");
    return hint.className = "se-settings-hint", hint.textContent = "滚动到列表底部时自动加载；每次检索最多加载 100 条结果。", toggle.addEventListener("click", () => {
      let next = toggle.getAttribute("aria-checked") !== "true";
      setAutoLoadMoreEnabled(next), toggle.setAttribute("aria-checked", String(next)), toggle.classList.toggle("se-settings-switch-on", next), next && refreshAutoLoad();
    }), row.append(head, hint), row;
  }
  var BOUNDARY = "去除链接中的跟踪条目，其余不再变动。";
  function buildPrivacyRow(engine3) {
    let row = document.createElement("div");
    row.className = "se-settings-row se-settings-row-stacked";
    let head = document.createElement("div");
    head.className = "se-settings-row-head";
    let label = document.createElement("span");
    label.className = "se-settings-label", label.textContent = "净化链接";
    let enabled = getSettings().privacy, toggle = document.createElement("button");
    toggle.type = "button", toggle.className = `se-settings-switch ${PRIVACY_TOGGLE_CLASS}`, toggle.setAttribute("role", "switch"), toggle.setAttribute("aria-checked", String(enabled)), toggle.setAttribute("aria-label", "净化链接"), toggle.classList.toggle("se-settings-switch-on", enabled);
    let knob = document.createElement("span");
    knob.className = "se-settings-knob", knob.setAttribute("aria-hidden", "true"), toggle.appendChild(knob), head.append(label, toggle);
    let hint = document.createElement("p");
    return hint.className = "se-settings-hint", hint.textContent = BOUNDARY, toggle.addEventListener("click", () => {
      let next = toggle.getAttribute("aria-checked") !== "true";
      setPrivacyEnabled(next), toggle.setAttribute("aria-checked", String(next)), toggle.classList.toggle("se-settings-switch-on", next), next && (cleanAddressBar(engine3.searchForm.param) ? log.info("净化链接：已去掉地址栏中的追踪参数") : log.info("净化链接：当前地址已无多余参数"));
    }), row.append(head, hint), row;
  }

  // src/features/tool-menu.ts
  var MENU_BUTTON_CLASS = "se-menu-btn", SETTINGS_ENTRY_CLASS = "se-menu-settings", POPUP_ID = "se-menu-popup";
  function collectEntries(engine3) {
    let entries = [], account = engine3.getAccountEntry?.();
    return account && entries.push(account), entries.push(...engine3.getExtraEntries?.() ?? []), entries;
  }
  var cleanups = [], toolMenu = {
    id: "tool-menu",
    name: "页头菜单",
    description: "在页头小标题行末提供该引擎的账户与站内功能入口。",
    engines: "all",
    supports() {
      return !0;
    },
    onNavigate({ engine: engine3 }) {
      let slot = document.querySelector(`.${MENU_SLOT_CLASS}`);
      if (!slot) {
        log.warn("未找到菜单挂载点，页头菜单未挂载");
        return;
      }
      if (slot.querySelector(`.${MENU_BUTTON_CLASS}`)) return;
      if (engine3.directSettingsMenu) {
        slot.append(buildDirectSettingsButton(engine3)), cleanups = [], log.info("页头设置按钮已挂载");
        return;
      }
      let { button: button2, popup } = buildMenu(engine3);
      slot.append(button2, popup), cleanups = [], wire(button2, popup, cleanups), log.info("页头菜单已挂载");
    },
    dispose() {
      for (let off of cleanups) off();
      cleanups = [], document.querySelector(`.${MENU_BUTTON_CLASS}`)?.remove(), document.getElementById(POPUP_ID)?.remove();
    }
  };
  function buildDirectSettingsButton(engine3) {
    let button2 = document.createElement("button");
    return button2.type = "button", button2.className = `${MENU_BUTTON_CLASS} se-menu-btn-settings`, button2.textContent = "菜单", button2.title = "附加设置", button2.setAttribute("aria-haspopup", "dialog"), button2.setAttribute("aria-label", "打开附加设置"), button2.addEventListener("click", () => openSettingsPanel({ engine: engine3 })), button2;
  }
  function buildMenu(engine3) {
    let button2 = document.createElement("button");
    button2.type = "button", button2.className = MENU_BUTTON_CLASS, button2.textContent = "菜单", button2.setAttribute("aria-haspopup", "true"), button2.setAttribute("aria-expanded", "false"), button2.setAttribute("aria-controls", POPUP_ID);
    let popup = document.createElement("div");
    popup.className = "se-menu-popup", popup.id = POPUP_ID, popup.setAttribute("role", "menu"), popup.toggleAttribute("inert", !0);
    let nav = document.createElement("nav");
    nav.className = "se-menu-nav", nav.setAttribute("aria-label", `${engine3.name} 功能入口`), nav.appendChild(buildSettingsEntry(engine3));
    for (let entry of collectEntries(engine3)) {
      let a = document.createElement("a");
      a.className = "se-menu-link", a.href = entry.href, a.target = "_blank", a.rel = "noopener noreferrer", a.setAttribute("role", "menuitem");
      let label = document.createElement("span");
      label.className = "se-menu-label", label.textContent = entry.label, a.appendChild(label), nav.appendChild(a);
    }
    return popup.appendChild(nav), { button: button2, popup };
  }
  function buildSettingsEntry(engine3) {
    let button2 = document.createElement("button");
    button2.type = "button", button2.className = `se-menu-link ${SETTINGS_ENTRY_CLASS}`, button2.setAttribute("role", "menuitem");
    let label = document.createElement("span");
    return label.className = "se-menu-label", label.textContent = "附加设置", button2.appendChild(label), button2.addEventListener("click", () => {
      openSettingsPanel({ engine: engine3 });
    }), button2;
  }
  function wire(button2, popup, off) {
    let isOpen = () => !popup.hasAttribute("inert"), setOpen = (open) => {
      popup.toggleAttribute("inert", !open), popup.classList.toggle("se-menu-open", open), button2.setAttribute("aria-expanded", String(open)), button2.classList.toggle("se-menu-btn-active", open);
    }, toggle = () => setOpen(!isOpen());
    button2.addEventListener("pointerdown", toggle), off.push(() => button2.removeEventListener("pointerdown", toggle));
    let onKeyClick = (event) => {
      event.detail === 0 && toggle();
    };
    button2.addEventListener("click", onKeyClick), off.push(() => button2.removeEventListener("click", onKeyClick));
    let onLinkClick = () => setOpen(!1);
    popup.addEventListener("click", onLinkClick), off.push(() => popup.removeEventListener("click", onLinkClick));
    let onKey = (event) => {
      event.key === "Escape" && isOpen() && setOpen(!1);
    };
    document.addEventListener("keydown", onKey), off.push(() => document.removeEventListener("keydown", onKey));
    let onDocPointerDown = (event) => {
      if (!isOpen()) return;
      let target = event.target;
      target && (button2.contains(target) || popup.contains(target)) || setOpen(!1);
    };
    document.addEventListener("pointerdown", onDocPointerDown, !0), off.push(() => document.removeEventListener("pointerdown", onDocPointerDown, !0));
  }

  // src/features/pagetual-guard.ts
  var PAGETUAL_UI_SELECTORS = [
    "#pagetual-sideController",
    "#pagetual-picker",
    ".pagetual_pageBar"
  ], SETTLE_MS = 100, observer2 = null, timer = 0, engine2 = null, announced = !1;
  function setPagetualOptOut() {
    try {
      let pageWindow = typeof unsafeWindow > "u" ? window : unsafeWindow;
      pageWindow.initedPagetual = !0;
    } catch {
    }
  }
  var pagetualGuard = {
    id: "pagetual-guard",
    name: "停用永页机",
    description: "检测到东方永页机时使其退出，拼页由本脚本负责。",
    /*
     * 只在本脚本自己接管拼页的引擎上启用：
     * 其它引擎若把永页机赶走就等于连翻页都没了。
     */
    engines: ["bing", "google", "baidu"],
    supports() {
      return !0;
    },
    onNavigate(ctx) {
      engine2 = ctx.engine, setPagetualOptOut(), document.getElementById(ROOT_ID) && (cleanNow(), startObserver());
    },
    dispose() {
      stopObserver();
    }
  };
  function cleanNow() {
    let removed = 0;
    for (let selector of PAGETUAL_UI_SELECTORS)
      for (let el of Array.from(document.querySelectorAll(selector)))
        el.remove(), removed++;
    if (document.body?.classList.remove("pagetual-picker"), engine2) {
      let source = document.getElementById(SOURCE_ID);
      if (source)
        for (let item of Array.from(
          document.querySelectorAll(engine2.resultItemSelector)
        ))
          item.closest(`#${SOURCE_ID}`) || item.closest(".se-item") || (source.appendChild(item), removed++);
    }
    removed > 0 && !announced && (announced = !0, log.warn("[永页机] 检测到东方永页机，已停用其界面并由本脚本接管拼页"));
  }
  function startObserver() {
    observer2 || !document.body || (observer2 = new MutationObserver(() => {
      timer || (timer = window.setTimeout(() => {
        timer = 0, cleanNow();
      }, SETTLE_MS));
    }), observer2.observe(document.body, { childList: !0, subtree: !0 }));
  }
  function stopObserver() {
    observer2?.disconnect(), observer2 = null, window.clearTimeout(timer), timer = 0, engine2 = null;
  }

  // src/features/settings-cleanup.ts
  var HIDDEN_BLOCK_CLASS = "se-setting-superseded", NOTE_CLASS = "se-settings-note", NOTE_HOST_ID = "se-settings-note-host";
  function whenPresent(selector, callback, timeoutMs = 15e3) {
    let stopped = !1, timer2 = null, tryNow = () => {
      let el = document.querySelector(selector);
      return el ? (callback(el), !0) : !1;
    };
    if (tryNow()) return () => {
    };
    let observer3 = new MutationObserver(() => {
      stopped || tryNow() && (stopped = !0, observer3.disconnect(), timer2 && clearTimeout(timer2));
    });
    return observer3.observe(document, { childList: !0, subtree: !0 }), timer2 = setTimeout(() => {
      stopped || (stopped = !0, observer3.disconnect());
    }, timeoutMs), () => {
      stopped = !0, observer3.disconnect(), timer2 && clearTimeout(timer2);
    };
  }
  function foldBlock(el, label, reason) {
    if (el.classList.contains(HIDDEN_BLOCK_CLASS)) return !1;
    el.classList.add(HIDDEN_BLOCK_CLASS);
    let content = el.querySelector(".me_subsection_r") ?? el, details = document.createElement("details");
    details.className = "se-setting-fold";
    let summary = document.createElement("summary");
    summary.className = "se-setting-fold-summary";
    let title = document.createElement("span");
    title.className = "se-setting-fold-label", title.textContent = label;
    let why = document.createElement("span");
    why.className = "se-setting-fold-reason", why.textContent = reason, summary.append(title, why), details.appendChild(summary);
    let body = document.createElement("div");
    for (body.className = "se-setting-fold-body"; content.firstChild; ) body.appendChild(content.firstChild);
    return details.appendChild(body), content.appendChild(details), !0;
  }
  function ensureNoteHost(count) {
    if (document.getElementById(NOTE_HOST_ID)) return;
    let anchor = document.querySelector("#search-section-content, .me_sectioncontent, form");
    if (!anchor || !anchor.parentElement) return;
    let note = document.createElement("div");
    note.id = NOTE_HOST_ID, note.className = NOTE_CLASS;
    let text2 = document.createElement("p");
    text2.className = "se-settings-note-text", text2.textContent = `本脚本接管了 ${count} 项搜索结果页行为，相关设置已折叠。它们不影响脚本工作，展开可以查看原设置。`, note.appendChild(text2), anchor.parentElement.insertBefore(note, anchor);
  }
  var settingsCleanup = {
    id: "settings-cleanup",
    name: "设置页清理",
    description: "在搜索设置页折叠已被本脚本取代的设置项。",
    engines: "all",
    /*
     * 只在实现了 isSettingsPage + getSupersededSettings 的引擎上运行。
     * 两者缺一就不启用 —— 否则会拿着空清单跑一遍，白费力气。
     */
    supports(engine3) {
      return !!(engine3.isSettingsPage && engine3.getSupersededSettings);
    },
    onNavigate(ctx) {
      let engine3 = ctx.engine;
      if (!engine3.isSettingsPage?.(ctx.url)) return;
      let list = engine3.getSupersededSettings?.() ?? [];
      if (list.length === 0) return;
      log.info(`设置页清理：共 ${list.length} 项待处理`);
      let folded = 0;
      for (let item of list)
        whenPresent(item.selector, (el) => {
          el instanceof HTMLElement && foldBlock(el, item.label, item.reason) && (folded++, log.info(`设置页清理：已折叠「${item.label}」`), ensureNoteHost(list.length));
        });
    }
  };

  // src/features/index.ts
  var ALL_FEATURES = [
    stripToResults,
    toolMenu,
    pagetualGuard,
    loadMore,
    settingsCleanup
  ];

  // src/styles/base.css
  var base_default = `/**
 * 瑞士风格（International Typographic Style）基础样式
 *
 * 设计原则：
 *   1. 层级由排版建立，而非装饰 —— 字号、字重、字距的对比就是结构
 *   2. 严格网格 —— 左侧等宽栏放序号，右侧内容栏对齐，条目间用规则线切割
 *   3. 色彩极度克制 —— 纯黑白 + 每引擎唯一的品牌强调色
 *   4. 拒绝装饰 —— 无圆角、无阴影、无渐变、无悬浮抬升效果
 *   5. 留白即呼吸 —— 大间距是版面的组成部分，不是浪费
 *
 * 所有 rem 尺寸以 16px 根字号为基准。strip-to-results 重写时会把
 * html.se-root-html 的 font-size 复位到 16px —— 百度等引擎会用
 * 100px 根字号做 rem 布局，不复位会让整套版面放大数倍。
 *
 * 后续精修可在此基础上迭代，本文件保持单一来源，不散落到其他位置。
 */

body.se-stripped {
  margin: 0;
  padding: 0;
  background: var(--se-bg);
  color: var(--se-fg);
  font: 400 16px/1.55 'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Hiragino Sans GB',
    'Microsoft YaHei', sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/*
 * 强调色由 Runner 按 EngineAdapter.theme 追加在本文件之后。
 * 这里只声明与引擎无关的中性令牌。
 */
:root {
  --se-bg: #fff;
  --se-fg: #111;
  --se-rule: #111;
  --se-line: #e0e0e0;
  --se-muted: #767676;
  --se-snippet: #333;
  --se-placeholder: #a8a8a8;
  /*
   * 浮层遮罩。
   *
   * 刻意**不**用 --se-fg 混色：那个变量在深色下是接近白的 #f2f2f2，
   * 混出来是一层浅色，打在深色页面上等于把背景「提亮」——
   * 与遮罩应有的「压暗、把注意力收拢到面板上」正好相反。
   * 遮罩的颜色与主题无关，永远是压暗。
   */
  --se-scrim: rgba(0, 0, 0, 0.45);
  /*
   * 声明配色方案，让**原生控件**（<select> 的下拉列表、滚动条、
   * 输入框内部的自动填充底色）跟随我们这套调色板。
   * 不声明的话浏览器按浅色渲染这些由 UA 绘制的部分，
   * 在深色页面里就会冒出一块白底 —— 下拉框尤其明显。
   */
  color-scheme: light;
}

/* 跟随系统深色偏好。深色下仍保持瑞士风格的高对比与纯色强调。 */
@media (prefers-color-scheme: dark) {
  :root {
    --se-bg: #0d0d0d;
    --se-fg: #f2f2f2;
    --se-rule: #f2f2f2;
    --se-line: #2e2e2e;
    --se-muted: #9a9a9a;
    --se-snippet: #d4d4d4;
    /*
     * 占位文字比浅色下的 #a8a8a8 略暗，但比原来的 #6a6a6a 亮：
     * 深色底上 #6a6a6a 的对比度偏低，几乎看不出写了什么；
     * 同时它仍明显暗于正文 #f2f2f2，能一眼区分「占位」与「已填内容」。
     */
    --se-placeholder: #8a8a8a;
    /* 深色页面本身已经很暗，遮罩加重一点才看得出层次 */
    --se-scrim: rgba(0, 0, 0, 0.62);
    color-scheme: dark;
  }
}

#se-root {
  max-width: 62rem;
  margin: 0 auto;
  padding: 3.5rem 2rem 6rem;
}

/*
 * 隐藏必应的「外壳」：顶栏、页脚、侧栏、广告位、遮罩。
 *
 * 重写时原站 DOM 已被整体搬进 \`#se-source\`（1px 裁剪容器），本来看不见。
 * 但必应的脚本在重写之后仍会跑，并把自己的一些外壳**重新插回 body** ——
 * 实测页脚（\`footer#b_footer\` 及其内的 \`#b_footerItems\`、备案链接）会被重新插入
 * 并正常显示在重写后的页面底部。
 *
 * 之所以是「逐个 id 列出」而不是「隐藏 body 下所有外来元素」：
 * 后者会连**其它脚本**插到 body 上的 UI 一起隐藏掉 ——
 * 那些节点不归我们管，不能用一条通用规则扫掉。
 *
 * ⚠️ 清单里**绝不能**出现 \`#b_results\` / \`#b_content\` / \`.b_pag\` ——
 * 它们是隐藏的数据源：结果从这里提取，分页线索也靠它判断
 * 「还有没有下一页」（见 strip-to-results 的 watchSourcePagination）。
 * \`#b_context\` 可以藏：直答区是把它内部的 \`.b_ans\` 节点搬进
 * 我们自己的列表，不依赖这个容器可见。
 *
 * 这份清单按实测的必应结构整理，改版后若有新的外壳需要补进来，加在这里。
 */
#b_header,
#b_footer,
#b_pole,
#b_context,
#b_ads,
#b_TriviaOverlay,
.overlay-dimmer,
body.se-stripped > footer,
body.se-stripped > header {
  display: none !important;
}

/*
 * 隐藏必应的「选中文字」快捷搜索浮窗。
 *
 * 选中页面文字时必应会弹出一条「搜索 / 复制 / 地图 / Copilot」小浮层。
 * 它是给**原站**结果用的交互，在重写后的页面上既多余又突兀，应当隐去。
 *
 * 这些 id 来自必应按需加载的 QuickSearch 样式表
 * （r.bing.com/rp/UFVfAE_erDWnmiQS0T0UDoL3UwQ.css），是它的完整元素清单：
 *   #qs_searchBoxOuter 外层容器（挂到 body 上）
 *   #qs_searchBox / #qs_copyBox / #qs_mapBox / #qs_chatBox  四个按钮
 * 隐藏外层容器即可，但按钮一并写上，免得样式表改版后容器换名。
 *
 * 同样刻意按 id 精确命中，不波及第三方 UI。
 */
#qs_searchBoxOuter,
#qs_searchBox,
#qs_copyBox,
#qs_mapBox,
#qs_chatBox {
  display: none !important;
}

/* ---- 原站内容的隐藏容器 ---- */

/*
 * 重写时必应原有 DOM 被整体搬进这里，而不是删除。
 *
 * **为什么不用 display: none**：这是必应自己的 DOM，它的脚本还会往里
 * 渲染晚到的分页线索（watchSourcePagination 依赖这一点）。保持正常的
 * 布局与可见性语义，避免原站脚本因为「不可见」而改变行为。
 * 因此改为「仍然渲染、但完全看不见」：
 *
 *   position: absolute + 1px + overflow: hidden
 *     —— 不占据文档流位置，尺寸近零，内容被裁掉
 *   contain: paint
 *     —— 让其中的 position: fixed 后代以本容器为包含块。
 *        否则页面里若有固定定位元素（如必应的悬浮顶栏），
 *        它会摆脱裁剪浮到我们重写后的页面之上。
 *   pointer-events: none
 *     —— 不拦截鼠标（脚本主动 el.click() 不受影响）
 */
.se-source {
  position: absolute;
  top: 0;
  left: 0;
  width: 1px;
  height: 1px;
  overflow: hidden;
  contain: paint;
  pointer-events: none;
}

/* ---- 页头 ---- */

.se-masthead {
  margin-bottom: 2.5rem;
  padding-bottom: 1.25rem;
  border-bottom: 3px solid var(--se-rule);
}

.se-brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  /* 与下方搜索框的间距改由 .se-brand-row 承担（那一行还要放菜单按钮） */
  margin: 0;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--se-muted);
}

/* 唯一的装饰：纯色方块 */
.se-mark {
  width: 0.7rem;
  height: 0.7rem;
  background: var(--se-accent);
  flex: none;
}

/* ---- 查询词：同时是页面大标题与搜索输入 ---- */

.se-query-form {
  display: block;
}

/*
 * 输入框沿用大标题排版，去掉原生外观。
 *
 * 交互提示的设计意图：
 *   平时      —— 就是一个普通标题，无任何装饰
 *   悬停      —— 虚线框出现，提示「这里可以输入」
 *   聚焦      —— 虚线框消失，避免干扰实际输入
 *   失焦      —— 立即还原为原查询词（见 runner 中的 blur 处理）
 *
 * 因此刻意不用聚焦时的下划线：那会与输入状态混淆，
 * 且占据布局空间导致文字跳动。
 */
.se-query {
  display: block;
  width: 100%;
  margin: 0;
  padding: 0 0 0.1rem;
  font-family: inherit;
  font-size: 2.5rem;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.025em;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 0;
  appearance: none;
  word-break: break-word;
  /* 虚线框用 outline 实现，不占布局空间，避免悬停时文字抖动 */
  outline: 1px dashed transparent;
  outline-offset: 0.35rem;
  transition: outline-color 0.12s ease;
}

.se-query::placeholder {
  color: var(--se-placeholder);
}

/* 悬停：虚线框提示可编辑 */
.se-query:hover {
  outline-color: var(--se-muted);
}

/* 聚焦：移除虚线框（此时已在输入，不需再提示）。
   宽度需显式归零——部分浏览器对 type=search 有默认 outline 宽度，
   只置 outline: none 时会留下 3px 的透明轮廓，偶发显示为焦点环。 */
.se-query:focus {
  outline: 0 dashed transparent;
  outline-color: transparent;
}

/* 隐藏 type=search 的原生清除按钮，保持版面干净 */
.se-query::-webkit-search-cancel-button {
  appearance: none;
}

.se-stat {
  margin: 0.6rem 0 0;
  font-size: 0.8125rem;
  letter-spacing: 0.02em;
  color: var(--se-muted);
}

/* ---- 结果条目：左序号栏 + 右内容栏 ---- */

.se-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

/*
 * 条目定位为 relative，使 .se-hit 能相对整条绝对定位；
 * padding-right 预留出标记线位置，避免覆盖文字。
 */
.se-item {
  position: relative;
  display: grid;
  grid-template-columns: 3.5rem 1fr;
  gap: 0 1rem;
  padding: 1.75rem 1.5rem 1.75rem 0;
  border-top: 1px solid var(--se-line);
  /*
   * 整条卡片不可选中。
   * 整块可点的条目上，拖选会选出一片无意义的文本，且与点击跳转冲突。
   * 需要链接地址时仍可用右键「复制链接地址」。
   */
  user-select: none;
  -webkit-user-select: none;
}

.se-item:first-child {
  border-top: 0;
  padding-top: 0;
}

/*
 * stretched link：透明锚点铺满整条，实现「整块可点」。
 * 相比给整块包 <a>，保留了标题内独立链接的语义
 * （中键新标签、复制链接、右键菜单均正常）。
 *
 * 层序（自下而上）：.se-hit → .se-num/.se-body → .se-link
 * hit 在最底层，因此整条任何位置都能命中它；
 * 内容层虽在上方，但设 pointer-events: none 让点击穿透给 hit，
 * 文本选择则交给 ::selection 与 .se-link 自行处理。
 */
.se-hit {
  position: absolute;
  inset: 0;
  z-index: 0;
}

.se-hit:focus-visible {
  outline: 2px solid var(--se-accent);
  outline-offset: -2px;
}

/*
 * 悬停反馈：只靠标题变为强调色 + 下划线展开（见下方 .se-item:hover .se-link）。
 * 不再给整条加背景色 —— 那会让版面出现块状色差，
 * 且与「整条可点」的透明覆盖层叠加后显得浑浊。
 */

/*
 * 内容层设 pointer-events: none，让点击穿透到下层的 hit，
 * 这样序号、来源、摘要、空白处都可点击。
 *
 * 注意：直接用 z-index 抬高内容层是错的 —— 那会让内容挡住 hit，
 * 只有落在两个 grid 单元的缝隙（即 se-hit 本身）才能点击。
 * 早期实现正是踩了这个坑，只有部分区域可点。
 *
 * 文本选择：整条已设 user-select: none，拖选不会产生高亮块。
 * min-width: 0 让 grid 单元可收缩，否则长 URL / 摘要会撑破布局。
 */
.se-num,
.se-body {
  position: relative;
  z-index: 1;
  pointer-events: none;
}

.se-body {
  min-width: 0;
}

/* 标题链接需真实可点：中键新标签、复制链接、右键菜单都依赖它 */
.se-link {
  position: relative;
  z-index: 2;
  pointer-events: auto;
  color: inherit;
  text-decoration: none;
  /* 下划线置于文字下方，用细线而非颜色变化表示可点击 */
  background-image: linear-gradient(var(--se-accent), var(--se-accent));
  background-repeat: no-repeat;
  background-position: 0 100%;
  background-size: 0 2px;
  transition: background-size 0.18s ease, color 0.18s ease;
}

/*
 * 必须单独压掉外部的 text-decoration。
 *
 * 必应的样式表里有一条 \`a:hover\` 下划线规则（线上实测，快照里加载不到它的外链 CSS）。
 * 上面的 \`.se-link { text-decoration: none }\` 没有 id，特异性不够 ——
 * 鼠标直接压在标题上时仍会被加上一条文字下划线，与我们的 2px 渐变线叠加，
 * 表现为「悬停标题时下划线更粗」，而悬停条目的其它位置时不会。
 * 用 #se-root 提高特异性并加 !important，钉死为无装饰。
 */
#se-root .se-link,
#se-root .se-link:hover,
#se-root .se-link:focus {
  text-decoration: none !important;
}

/*
 * 悬停反馈作用于整条卡片：标题转为强调色并展开下划线。
 * 整块可点的条目上，用户视线落在卡片任意位置都应得到同一反馈，
 * 而不只是鼠标正好压在那几个字的标题上。
 */
.se-item:hover .se-link {
  color: var(--se-accent);
  background-size: 100% 2px;
}

/* 键盘聚焦（Tab 到链接）时同样给出反馈 */
.se-link:focus-visible {
  color: var(--se-accent);
  background-size: 100% 2px;
  outline: 2px solid var(--se-accent);
  outline-offset: 2px;
}

/* 序号：等宽数字，形成纵向韵律。
   line-height 与下方来源行高对齐，使序号与来源文字落在同一基线上。 */
.se-num {
  font-family: 'SF Mono', 'JetBrains Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1.5rem;
  color: var(--se-accent);
  font-variant-numeric: tabular-nums;
}

.se-cite {
  display: block;
  margin: 0 0 0.45rem;
  font-family: 'SF Mono', 'JetBrains Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 0.8125rem;
  font-style: normal;
  line-height: 1.5;
  color: var(--se-muted);
  /* 原站可能给 cite 设 nowrap / 省略号；这里强制完整换行显示 */
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  overflow-wrap: anywhere;
}

.se-title {
  margin: 0 0 0.4rem;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: -0.01em;
}

/*
 * 「已排除」标签必须与标题文字**同一行**。
 *
 * 结构是 \`<h2 class="se-title"><span class="se-tag">已排除</span><a class="se-link">标题</a></h2>\`，
 * 两者本来就在同一行内自然排列。但只要标题锚点被算成块级
 * （原站那种 \`h2 a\` 一类的通用规则就会这么做），标签就会被挤到单独一行。
 *
 * 这里显式钉住两者的 display：
 *   - 只写**我们自己的类名**，不波及原站或第三方脚本的样式；
 *   - 用 !important 是因为要压过原站通用规则 —— 而这两个元素的结构
 *     本来就是行内排列，钉死不会带来副作用。
 */
.se-title .se-tag {
  display: inline-block !important;
}

.se-title .se-link {
  display: inline !important;
}

/* .se-link 的排版、悬停与聚焦规则统一在层序段落中定义 */

.se-snippet {
  margin: 0;
  max-width: 46em;
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--se-snippet);
}

/* ---- 加载更多 ---- */

/*
 * 结果列表之后不再有分割线：页码栏移除后，这里只剩一个按钮，
 * 用留白与列表分开即可。粗规则线保留给页头与更重要的分区。
 */
.se-more {
  display: flex;
  justify-content: center;
  margin-top: 2.5rem;
}

.se-more[hidden] {
  display: none;
}

.se-more-button {
  appearance: none;
  margin: 0;
  padding: 0.9rem 3rem;
  font-family: 'SF Mono', 'JetBrains Mono', Consolas, 'Liberation Mono', monospace;
  font-size: 0.8125rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--se-fg);
  background: transparent;
  border: 1px solid var(--se-fg);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.se-more-button:hover:not(:disabled) {
  color: var(--se-bg);
  background: var(--se-fg);
}

.se-more-button:focus-visible {
  outline: 2px solid var(--se-accent);
  outline-offset: 2px;
}

.se-more-button:disabled {
  cursor: default;
  opacity: 0.55;
}

/* ---- 其他 ---- */

.se-empty {
  margin: 0;
  padding: 3rem 0;
  border-top: 1px solid var(--se-line);
  color: var(--se-muted);
}

/* 直答区等附加区块 */
.se-extra {
  margin-bottom: 2.5rem;
  padding-bottom: 2rem;
  border-bottom: 1px solid var(--se-line);
}

/* ==========================================================================
   页头菜单
   --------------------------------------------------------------------------
   放在页头小标题「BING — 检索」那一行的末尾，点开后在按钮下方弹出条目面板。

   相比先前的贴边侧边栏，这一版简单得多：
   按钮是文档流内的普通元素，位置稳定，不需要遮罩层，
   也不必处理贴边触摸区与滑入动画带来的各种边界情况。
   ========================================================================== */

/* ---- 小标题行：左品牌 + 右菜单 ---- */

.se-brand-row {
  display: flex;
  /* 按基线对齐：菜单是文字标签，与小标题的字底对齐才不显歪 */
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  /* 与下方搜索框的间距统一在这里设置 */
  margin-bottom: 1.75rem;
}

/* 挂载点：同时作为弹出层的定位参照 */
.se-menu-slot {
  position: relative;
}

/* ---- 触发按钮 ---- */

/*
 * 做成「文字标签」而不是图标按钮：
 * 沿用与小标题同一套字号、字距与大写转换，
 * 视觉上像是那一行的自然延续，而不是外挂的控件。
 */
.se-menu-btn {
  padding: 0;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--se-muted);
  background: transparent;
  border: 0;
  border-radius: 0;
  cursor: pointer;
  transition: color 0.15s ease;
}

.se-menu-btn:hover,
.se-menu-btn-active {
  color: var(--se-accent);
}

.se-menu-btn:focus-visible {
  outline: 2px solid var(--se-accent);
  outline-offset: 3px;
}

/* ---- 弹出面板 ---- */

/*
 * 锚在按钮下方、右对齐。
 * 收起时用 display: none（配合 inert）：它不参与布局，
 * 也不会被 Tab 或读屏软件访问到。
 */
.se-menu-popup {
  position: absolute;
  top: calc(100% + 0.5rem);
  right: 0;
  z-index: 10;
  min-width: 13rem;
  /* 水平内边距挪到条目上（见 .se-menu-link）：这样悬停灰底与分隔线
     都能通栏，否则灰底会两侧各缩进一截，显得悬浮 */
  padding: 0.25rem 0;
  background: var(--se-bg);
  border: 1px solid var(--se-fg);
}

.se-menu-popup[inert] {
  display: none;
}

.se-menu-nav {
  display: flex;
  flex-direction: column;
}

.se-menu-link {
  padding: 0.7rem 0.9rem;
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid var(--se-line);
  /* 「结果过滤设置」是 <button>，需显式清掉浏览器默认外观 */
  text-align: left;
  background: transparent;
  border-left: 0;
  border-right: 0;
  border-top: 0;
  cursor: pointer;
}

.se-menu-link:last-child {
  border-bottom: 0;
}

/*
 * 条目文字单独一层。
 *
 * ## 为什么要 inline-block
 *
 * 外部样式表（浏览器默认、其他扩展、或本脚本旧版本残留）常给
 * a:hover 加 text-decoration: underline。而按 CSS 规范，
 * text-decoration **不会传播进原子行内元素**（inline-block 属于此类），
 * 所以把文字放进 display: inline-block 的 span，
 * 那些下划线就落不到文字上 —— 即「让链接不置于文字上」。
 * 这也是唯一能挡住**别人**加的装饰的办法：
 * 若下划线加在 <a> 上，后代设 text-decoration: none 是无效的。
 *
 * ## 层级
 *
 * 字号比面板标题略小、颜色取次要色，
 * 让它读起来是菜单项而非页面标题 —— 弹出菜单本身是辅助性内容，
 * 文字不该与正文争视觉重量。
 */
.se-menu-label {
  display: inline-block;
  font-size: 0.8125rem;
  color: var(--se-muted);
  text-decoration: none;
}

/*
 * 悬停：加灰底突出显示。
 *
 * 这里刻意不用「强调色 + 下划线」—— 那是结果条目与页码的语汇；
 * 弹出菜单里底色才是更惯用的「当前项」表达，
 * 也避免强调色在菜单这种小面积里显得过重。
 *
 * 同时把该条目的下分隔线隐去：条目之间本就有 1px 分隔线，
 * 灰底一衬，它会看着像悬停产生的下划线。
 * 用 transparent 而非 none，宽度不变故不会引起 1px 抖动。
 */
.se-menu-link:hover {
  background: color-mix(in srgb, var(--se-fg) 8%, transparent);
  border-bottom-color: transparent;
}

.se-menu-link:focus-visible {
  outline: 2px solid var(--se-accent);
  outline-offset: 2px;
}

/* ==========================================================================
   结果过滤
   --------------------------------------------------------------------------
   两种作用（由设置面板选择）：
     badge  标题前加「已排除」小标签，结果照常显示
     hide   整条降级为占位：序号保留、内容灰字、可单击展开

   隐藏刻意不删除条目 —— 序号是第一栏的纵向韵律，
   抽掉一条会让后面的编号整体前移，用户失去「这里原本有条结果」的线索。
   ========================================================================== */

/* ---- 标题前的标记 ---- */

/*
 * 标签刻意**不**用等宽字体栈。
 *
 * 等宽栈里的 Consolas 在 Windows 上没有中文字形，
 * 浏览器会为「已排除」这类汉字回退到默认衬线体（SimSun）——
 * 结果就是标签里的中文是衬线、标题是无衬线，两种字面拼在一起很别扭。
 * 因此直接继承正文的无衬线栈，与标题同源。
 */
.se-tag {
  display: inline-block;
  margin-right: 0.5rem;
  padding: 0.1rem 0.4rem;
  font-family: inherit;
  /*
   * 基准字号从 11px 提到 14px。
   * 原来比标题（1.25rem = 20px）小太多，视觉上像另一个层级的注脚；
   * 作为标题的前缀标记，它应当读起来是标题的一部分。
   */
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.3;
  letter-spacing: 0.02em;
  vertical-align: 0.06em;
  white-space: nowrap;
}

/* 「已排除」：用强调色描边，是提示而非错误 */
.se-tag-excluded {
  color: var(--se-accent);
  border: 1px solid var(--se-accent);
}

/* ---- 隐藏态的占位条目 ---- */

/*
 * .se-tag-hidden 是隐藏条目**唯一**的内容：
 * 它占的是链接那一行的位置，不是标题前的标签。
 * 因此这里把它从 .se-tag 的「行内小标记」语境里拉出来，
 * 复位为一块独立的块级文字（字号也按正文行来，不是标签的尺寸）。
 */
.se-tag-hidden {
  display: block;
  margin: 0;
  padding: 0;
  font-size: 0.9375rem;
  font-weight: 400;
  line-height: 1.5;
  letter-spacing: normal;
  vertical-align: baseline;
  color: var(--se-muted);
}

/*
 * 隐藏时不保留标题与摘要：body 栏里只剩上面那行占位文字，
 * 位置就是正常条目的链接所在处（见 hideItemBody 的注）。
 *
 * 因此这里不再有 .se-cite / .se-title / .se-link 的降级规则 ——
 * 那些节点已被移出文档，只在恢复时才放回。
 */

/*
 * 悬停整条时占位文字转为前景色，让「可点」这件事在占位条上同样成立。
 */
.se-item-hidden {
  cursor: pointer;
}

.se-item-hidden:hover .se-tag-hidden {
  color: var(--se-fg);
}

/*
 * 刻意**不**给占位条任何焦点样式。
 *
 * 点击是为了展开，不是聚焦；冒出一个焦点框会让「点一下就恢复」
 * 这个动作显得像出了错。相应的 focus-within 规则已移除，
 * 并在 mousedown 阶段阻止了默认聚焦（见 bindHiddenToggle）。
 */

/* ---- 设置浮层 ---- */

.se-filter-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483200;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 4rem 1rem;
  overflow-y: auto;
  /* 压暗背景，把注意力收拢到面板上（颜色与主题无关，见 --se-scrim） */
  background: var(--se-scrim);
}

.se-filter-panel {
  width: 100%;
  max-width: 34rem;
  padding: 1.5rem;
  background: var(--se-bg);
  border: 1px solid var(--se-fg);
}

.se-filter-head {
  display: flex;
  /*
   * 居中对齐而非基线对齐：关闭键是本轮改成的方形图标按钮，
   * 没有文字基线可言；基线对齐会让它与标题错位。
   */
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 3px solid var(--se-rule);
}

.se-filter-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0.04em;
}

/*
 * 关闭按钮：一个「×」字形按钮。
 *
 * 用固定方形盒 + 居中字形的做法，而不是给 <button> 直接写字 ——
 * 文字按钮的可点区域会随字号浮动，方形盒则给出稳定、
 * 足够大的命中区（32px，满足触屏最小可点尺寸）。
 */
.se-filter-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  font: inherit;
  font-size: 1.25rem;
  line-height: 1;
  color: var(--se-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
}

.se-filter-close:hover {
  color: var(--se-accent);
}

.se-filter-rows {
  display: flex;
  flex-direction: column;
  /*
   * 与页头之间留出间距。
   * 这里原来靠一段简介文本的 margin 撑开，简介删掉后
   * 改由 rows 自己承担，否则列表会贴着页头那条规则线。
   */
  margin-top: 1rem;
  /*
   * 已有规则与下方的新增行之间不画分隔线。
   *
   * 两者是同一张列表的「上一段」与「下一段」，中间加一条 3px 粗线
   * 会把它们割成两个区块，读起来像两张表；
   * 用留白区分层级就够，规则线留给真正需要分隔的地方。
   */
}

/*
 * 空态：居中一行「- EMPTY -」。
 *
 * 定高 + 居中，是为了让面板在有无规则时高度不跳变 ——
 * 空的列表若只有一行文字紧贴页头，面板会显得没画完。
 */
.se-filter-empty {
  margin: 0;
  padding: 2.25rem 0;
  font-size: 0.8125rem;
  letter-spacing: 0.08em;
  text-align: center;
  color: var(--se-muted);
}

.se-filter-row {
  display: grid;
  grid-template-columns: 1fr 11rem auto;
  gap: 0.5rem;
  align-items: center;
  padding: 0.6rem 0;
  /*
   * 每行下边一条细线。
   * 最后一行也不例外 —— 它与下方的新增行之间靠留白区隔，
   * 但仍需要有线收住整列，否则已有规则看起来像没写完。
   */
  border-bottom: 1px solid var(--se-line);
}

/*
 * 输入控件：瑞士风格不用圆角与阴影，只用细描边。
 *
 * 注意 \`.se-filter-action\` 也在列表里。
 *
 * 面板里有两类下拉框：新增行用 \`.se-filter-select\`，
 * 已有规则行用 \`.se-filter-action\`（见 filter-panel.ts 的 buildRow）。
 * 早期版本只写了前者，于是已有规则的下拉框完全没有自定义样式 ——
 * 暗色模式下表现为一块原生白底、字体还是 Arial。
 *
 * ## 为什么这里用 !important
 *
 * 必应对 \`input\` 也有自己的样式规则，而且比我们的类选择器更具体
 * （实测把面板输入框染成 #444 文字配 #ddd 边框）。
 * 曾经的做法是「把必应样式表整体禁用」，但那会连带关掉**别的脚本**的样式，
 * 并让只靠原站 CSS 隐藏的浮层全部显形。所以改为在这里用 !important 兜底：
 * 只写自己的类名，绝不会波及页面上的其它任何元素。
 *
 * ⚠️ 用 !important 就意味着**各状态也必须一并 !important**，
 * 否则下面的 :focus / :hover / 错误态会被这里的声明压死、完全失效。
 * 这正是本文件里这几段都带 !important 的原因，改动时不要漏。
 */
.se-filter-input,
.se-filter-domain,
.se-filter-select,
.se-filter-action {
  min-width: 0;
  padding: 0.4rem 0.5rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--se-fg) !important;
  background-color: var(--se-bg) !important;
  border: 1px solid var(--se-line) !important;
  border-radius: 0 !important;
}

/*
 * 占位文字显式着色。
 * 不写就只能吃 UA 默认（深浅两种主题下都不是我们调过的灰），
 * 暗色下尤其偏暗、几乎看不清。
 */
.se-filter-input::placeholder,
.se-filter-domain::placeholder {
  color: var(--se-placeholder) !important;
  opacity: 1 !important;
}

/*
 * 焦点态给强调色描边。
 * 用 outline 而非 border-color：描边不参与布局，
 * 聚焦时控件不会因边框变粗而跳动。
 */
.se-filter-input:focus,
.se-filter-domain:focus,
.se-filter-select:focus,
.se-filter-action:focus {
  outline: 2px solid var(--se-accent) !important;
  outline-offset: -1px !important;
}

/* 输入不合法时给出可见反馈，而不是静默吞掉 */
/* 与上面同理：基础规则用了 !important，这里也必须跟上，否则描边出不来 */
.se-filter-input-invalid {
  border-color: var(--se-accent) !important;
}

.se-filter-add {
  display: grid;
  grid-template-columns: 1fr 11rem auto;
  gap: 0.5rem;
  /*
   * 与上方规则列表只靠留白区隔，不画线（见 .se-filter-rows 的注释）。
   * 这里用两倍于行内间距的空白，让「新增」读起来是独立的一段动作，
   * 又不至于像被切开成另一张表。
   */
  margin-top: 1.5rem;
}

/* 描边按钮：透明底 + 前景色描边，同样需要 !important 兜底（理由见上） */
.se-filter-add-btn,
.se-filter-remove {
  padding: 0.4rem 0.75rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--se-fg) !important;
  background-color: transparent !important;
  border: 1px solid var(--se-fg) !important;
  border-radius: 0 !important;
  cursor: pointer;
}

/* hover 必须也是 !important，否则上面的声明会把它压死、悬停毫无反馈 */
.se-filter-add-btn:hover,
.se-filter-remove:hover {
  color: var(--se-bg) !important;
  background-color: var(--se-fg) !important;
}

/* ==========================================================================
   附加设置弹窗
   --------------------------------------------------------------------------
   菜单第一项的落点：一个只有「行」的面板，每行左侧是名称、
   右侧是控件（进入按钮 / 开关）。

   视觉上刻意与结果过滤面板对齐 —— 同一个遮罩、同一种描边面板、
   同样 3px 的页头规则线。两者是同一套设置体系的上下两级，
   换层不应换语言。

   拒绝：无圆角、无阴影、无渐变、无漂浮抬升。
   开关也不用 iOS 那种胶囊，而是**方块滑块**：
   圆角胶囊与这里的排印体系不搭。
   ========================================================================== */

/* 遮罩复用 .se-filter-overlay 的规则（见 settings-panel.ts 同时挂两个类），
   这里只声明本弹窗自己的层级关系：它必须盖住菜单，但不改变 z-index 顺序 */
.se-settings-overlay {
  z-index: 2147483200;
}

.se-settings-panel {
  width: 100%;
  max-width: 30rem;
  padding: 1.5rem;
  background: var(--se-bg);
  border: 1px solid var(--se-fg);
}

.se-settings-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.75rem;
  /* 与页头同一种收束方式：3px 粗规则线，不用色块 */
  border-bottom: 3px solid var(--se-rule);
}

.se-settings-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0.04em;
}

/*
 * 关闭键与过滤面板的 .se-filter-close 完全同构。
 * 之所以不直接复用那个类：两个面板的生命周期独立，
 * 共用类名会在改动其中一个时悄悄影响另一个。
 */
.se-settings-close {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  font: inherit;
  font-size: 1.25rem;
  line-height: 1;
  color: var(--se-muted);
  background: transparent;
  border: 0;
  border-radius: 0;
  cursor: pointer;
}

.se-settings-close:hover {
  color: var(--se-accent);
}

.se-settings-close:focus-visible {
  outline: 2px solid var(--se-accent);
  outline-offset: 2px;
}

.se-settings-rows {
  display: flex;
  flex-direction: column;
  margin-top: 0.5rem;
}

/*
 * 一行设置：名称占满左侧，控件靠右。
 * 行间用细规则线切分 —— 与结果过滤面板的规则行同一手法，
 * 让两组设置看起来属于同一种排版体系。
 */
.se-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.9rem 0;
  border-bottom: 1px solid var(--se-line);
}

.se-settings-label {
  display: inline-block;
  font-size: 0.875rem;
  color: var(--se-fg);
}

/*
 * 带说明文字的行：名称与控件在上，说明另起一行铺满。
 *
 * 用纵向堆叠而不是「名称 — 控件 — 说明」三者同行：
 * 说明是一句话的完整语义，被挤在控件与名称之间会折成两三行窄柱，
 * 读起来像注释而不是正文。铺满整行后它才是可读的句子。
 */
.se-settings-row-stacked {
  flex-direction: column;
  align-items: stretch;
  gap: 0.4rem;
}

.se-settings-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

/*
 * 说明文字：小一号、次要色、等宽之外的常规字面。
 * 它承担「这个开关到底会影响什么」的解释责任，
 * 但不应与设置名称争视觉重量，因此压低到 muted。
 */
.se-settings-hint {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--se-muted);
}

/* 环境不支持 / 操作未完全生效时，说明文字转为强调色，避免被当成普通提示略过 */
.se-settings-hint-warn {
  color: var(--se-accent);
}

/*
 * 已处于官方无痕状态、本功能自动停用时的说明。
 *
 * 用次要色的斜体，而不是强调色：这不是错误，
 * 是「当前不需要它」的正常状态。用强调色会让人以为出了问题。
 */
.se-settings-hint-inactive {
  font-style: italic;
}

/* 开关不可用：降低不透明度并禁止指针，明确表达「点了也没用」 */
.se-settings-switch-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/*
 * 「进入」按钮：描边按钮，与过滤面板的「添加 / 删除」同一套。
 *
 * 这里同样需要 !important —— 必应对 button 有更具体的通用规则，
 * 会把我们的配色压掉（理由与 .se-filter-add-btn 完全相同，见上方注释）。
 */
.se-settings-action {
  flex: none;
  padding: 0.35rem 0.9rem;
  font: inherit;
  font-size: 0.8125rem;
  color: var(--se-fg) !important;
  background-color: transparent !important;
  border: 1px solid var(--se-fg) !important;
  border-radius: 0 !important;
  cursor: pointer;
}

.se-settings-action:hover {
  color: var(--se-bg) !important;
  background-color: var(--se-fg) !important;
}

.se-settings-action:focus-visible {
  outline: 2px solid var(--se-accent) !important;
  outline-offset: 2px !important;
}

/*
 * 开关。
 *
 * 关：细描边方块，空白。
 * 开：整块填入强调色 —— 用「实心」而不是「滑块位移」表达开启，
 *     因为在本套排印体系里，实心色块是最强的强调手段
 *     （与页头品牌方块、序号栏同一语汇）。
 *
 * 滑块仍然保留并做位移：触屏与读屏之外，它还给出「这是可切换控件」的形状线索。
 */
.se-settings-switch {
  position: relative;
  flex: none;
  width: 3.25rem;
  height: 1.5rem;
  padding: 0;
  background-color: transparent !important;
  border: 1px solid var(--se-fg) !important;
  border-radius: 0 !important;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.se-settings-knob {
  position: absolute;
  top: 50%;
  left: 3px;
  width: 0.85rem;
  height: 0.85rem;
  background: var(--se-fg);
  transform: translateY(-50%);
  transition: left 0.15s ease, background-color 0.15s ease;
}

/* 开启：强调色底 + 背景色滑块。颜色由令牌控制，暗色模式下自动提亮 */
.se-settings-switch-on {
  background-color: var(--se-accent) !important;
  border-color: var(--se-accent) !important;
}

.se-settings-switch-on .se-settings-knob {
  left: calc(100% - 0.85rem - 3px);
  background: var(--se-bg);
}

.se-settings-switch:hover {
  border-color: var(--se-accent) !important;
}

.se-settings-switch:focus-visible {
  outline: 2px solid var(--se-accent) !important;
  outline-offset: 2px !important;
}

/*
 * 底部留白区。
 * 目前是空的 —— 它的存在是为了让面板在只有两行时也不像一个
 * 「没画完的弹窗」，同时给后续设置项一个明确的追加位置。
 */
.se-settings-tail {
  min-height: 1.5rem;
}

/* ==========================================================================
 * 设置页清理
 * --------------------------------------------------------------------------
 * Bing 设置页（/account/general）上，把已被本脚本取代的设置项折叠起来。
 *
 * 风格约束与项目其余部分一致：直角、无阴影、3px 规则线，
 * 只用边框与字重分层，不引入任何圆角或投影。
 * ========================================================================== */

/* 顶部总说明 */
.se-settings-note {
  margin: 0 0 1.5rem;
  padding: 0.875rem 1rem;
  border-left: 3px solid var(--se-ink);
  background: transparent;
}

.se-settings-note-text {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--se-ink);
}

/* 被折叠的设置块 */
.se-setting-superseded {
  /* 原本的分隔线与内边距由折叠后的 summary 接管，这里只清理残留 */
  padding: 0;
  margin: 0;
}

.se-setting-fold {
  border-top: 1px solid var(--se-rule);
}

.se-setting-fold:last-child {
  border-bottom: 1px solid var(--se-rule);
}

.se-setting-fold-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 0.75rem;
  padding: 0.875rem 0;
  cursor: pointer;
  /* 去掉浏览器默认的三角标记，改用自绘的方块 */
  list-style: none;
}

.se-setting-fold-summary::-webkit-details-marker {
  display: none;
}

/* 自绘标记：一个实心方块，展开时变空心 */
.se-setting-fold-summary::before {
  content: "";
  flex: 0 0 auto;
  width: 0.5rem;
  height: 0.5rem;
  margin-right: 0.125rem;
  background: var(--se-ink);
  transform: translateY(-1px);
}

.se-setting-fold[open] > .se-setting-fold-summary::before {
  background: transparent;
  border: 1px solid var(--se-ink);
}

.se-setting-fold-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--se-ink);
  /* 折叠态下用删除线表达「此项已不适用」 */
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}

.se-setting-fold[open] > .se-setting-fold-summary .se-setting-fold-label {
  text-decoration: none;
}

.se-setting-fold-reason {
  flex: 1 1 auto;
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--se-muted);
}

.se-setting-fold-body {
  padding: 0 0 1rem 1.25rem;
}

@media (prefers-color-scheme: dark) {
  .se-setting-fold-summary::before {
    background: var(--se-ink);
  }

  .se-setting-fold[open] > .se-setting-fold-summary::before {
    border-color: var(--se-ink);
  }
}
`;

  // src/core/runner.ts
  function themeCss(engine3) {
    return `
:root{--se-accent:${engine3.theme.accent}}
@media (prefers-color-scheme: dark){:root{--se-accent:${engine3.theme.accentDark}}}`;
  }
  var Runner = class {
    engine = null;
    active = /* @__PURE__ */ new Set();
    disposers = [];
    cssInjected = !1;
    /**
     * 首次启动：确定引擎、建立导航监听、执行功能
     *
     * @param options.target 本产物的专属引擎（构建期指定）。
     *   给定后只考虑这一个引擎，非其搜索页则正常退出。
     *   这是多产物拆分后的常规路径 —— dotSearch for Bing 不会去处理 Google 页面。
     * @param options.force 测试用：跳过 URL 归属校验。
     *   验证脚本把抓取下来的页面喂给浏览器时，地址栏是本地服务地址而非
     *   bing.com，isSearchPage 必然不成立，脚本会静默退出。
     */
    async start(options = {}) {
      let engine3 = options.force ?? options.target ?? detectEngine(new URL(location.href));
      if (!engine3) {
        log.warn("当前页面不属于任何已适配的搜索引擎，脚本不启动。");
        return;
      }
      let forced = !!options.force, startUrl = new URL(location.href);
      if (!forced && !engine3.isSearchPage(startUrl) && !engine3.isSettingsPage?.(startUrl)) {
        log.info(`当前页面不是 ${engine3.name} 的搜索或设置页，脚本不启动。`);
        return;
      }
      if (engine3.isAlreadyInjected(document)) {
        log.warn("脚本已在本页面运行过，跳过重复注入。");
        return;
      }
      engine3.markInjected(document);
      try {
        this.engine = engine3, injectStyle(base_default + themeCss(engine3)), this.cssInjected = !0, this.disposers.push(
          onUrlChange((url) => {
            if (forced || options.target && !engine3.isSearchPage(url)) return;
            let next = detectEngine(url);
            next && (next === this.engine ? this.runAll(url) : (log.info(`切换引擎：${this.engine?.name ?? "-"} → ${next.name}`), this.teardownFeatures(), this.engine = next, this.runAll(url)));
          })
        ), await this.runAll(new URL(location.href), forced), log.info(`${engine3.name} 增强已启用，共 ${this.active.size} 个功能。`);
      } catch (err) {
        throw engine3.unmarkInjected(document), this.engine = null, err;
      }
    }
    /** 跑一轮所有功能（首次加载与换词后共用） */
    async runAll(url, forced = !1) {
      let engine3 = this.engine;
      if (!engine3) return;
      let belongs = engine3.isSearchPage(url) || !!engine3.isSettingsPage?.(url);
      if (!forced && !belongs) return;
      if (document.getElementById("se-root")) {
        if (ALL_FEATURES.filter((f) => f.id === "strip-to-results").map((f) => f.needsRebuild?.(engine3)).find((v) => v !== void 0) !== !0) {
          log.warn("[换词检测] 已重写且状态完整 → 跳过");
          return;
        }
        log.warn("[换词检测] 状态不完整 → 重建"), document.getElementById("se-root")?.remove();
      }
      if (!await waitForSelector(engine3.resultContainerSelector, { timeout: 8e3 })) {
        log.warn(`未等到结果容器：${engine3.resultContainerSelector}`);
        return;
      }
      let ctx = { engine: engine3, query: engine3.parseQuery(url) ?? "", url };
      for (let feature of ALL_FEATURES)
        this.matchesEngine(feature, engine3) && await this.runFeature(feature, ctx);
    }
    /** 执行单个功能；返回 Promise 以便按顺序等待（顺序见 features/index.ts） */
    async runFeature(feature, ctx) {
      if (ctx && !feature.supports(ctx.engine)) return;
      let context = ctx ?? { engine: this.engine, query: "", url: new URL(location.href) };
      try {
        await feature.onNavigate(context), this.active.add(feature);
      } catch (err) {
        log.error(`功能 ${feature.id} 执行失败：`, err);
      }
    }
    matchesEngine(feature, engine3) {
      return feature.engines === "all" || feature.engines.includes(engine3.id);
    }
    teardownFeatures() {
      for (let feature of this.active) feature.dispose?.();
      this.active.clear();
    }
    stop() {
      this.teardownFeatures();
      for (let off of this.disposers) off();
      this.disposers.length = 0, this.cssInjected && (document.getElementById("search-enhance-styles")?.remove(), this.cssInjected = !1);
    }
  };

  // src/index.ts
  var targetId = "baidu", targetEngine = activeEngines.find((e) => e.id === targetId);
  if (!targetEngine)
    log.warn(`本产物面向的引擎「${targetId}」未注册，脚本不启动。`);
  else if (!targetEngine.onHomePage?.(new URL(location.href))) {
    targetEngine.pagination && setPagetualOptOut();
    let runner = new Runner(), forced = globalThis.__SE_FORCE_ENGINE__, forceEngine = forced ? activeEngines.find((e) => e.id === forced) ?? void 0 : void 0;
    runner.start({ target: targetEngine, force: forceEngine }).catch(
      (err) => log.error("脚本启动失败：", err)
    );
  }
})();
