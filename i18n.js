'use strict';

// Localize only static markup captured before the app starts and text explicitly
// registered by uiText/uiAttr. Never scan database values or modify input values.
(() => {
  const STORAGE_KEY = 'findit-language';
  const languages = ['en', 'ar', 'es'];
  const catalog = window.FINDIT_TRANSLATIONS;
  const staticText = new Map();
  const ownedText = new Map();
  const ownedParts = new Map();
  const ownedAttributes = new Map();
  const placeholderImages = new Set();
  let language = 'en';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (languages.includes(saved)) language = saved;
  } catch (_) { /* The language still works for this session without storage. */ }

  const normalize = (source) => String(source).replace(/\s+/g, ' ').trim();
  const templates = Object.keys(catalog).filter((key) => /\{\d+\}/.test(key))
    .sort((a, b) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length)
    .map((key) => {
      const parameters = [];
      const pattern = key.split(/(\{\d+\})/).map((part) => {
        if (/^\{\d+\}$/.test(part)) {
          parameters.push(part);
          return '([\\s\\S]*?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      return { key, parameters, pattern: new RegExp('^' + pattern + '$') };
    });

  function translate(source) {
    source = String(source == null ? '' : source);
    if (language === 'en' || !source) return source;
    const normalized = normalize(source);
    const column = language === 'ar' ? 0 : 1;
    if (Object.prototype.hasOwnProperty.call(catalog, normalized)) {
      return catalog[normalized][column];
    }
    // Match the original string, not normalized user data within parameters.
    for (const template of templates) {
      const match = source.match(template.pattern);
      if (!match) continue;
      const values = new Map(template.parameters.map((parameter, i) => [parameter, match[i + 1]]));
      return catalog[template.key][column].replace(/\{\d+\}/g, (parameter) => values.get(parameter) || '');
    }
    // External service errors, codes, and unknown user text stay verbatim.
    return source;
  }

  function setText(node, source) {
    if (!node) return;
    const original = String(source == null ? '' : source);
    ownedText.set(node, original);
    node.textContent = translate(original);
  }

  function renderAttribute(binding) {
    if (typeof binding === 'string') return translate(binding);
    return translate(binding.template).replace(/\{(\d+)\}/g, (token, i) =>
      binding.values[i] == null ? token : String(binding.values[i]));
  }

  function setAttribute(node, name, source, parameters) {
    if (!node) return;
    const values = ownedAttributes.get(node) || new Map();
    const binding = parameters ? { template: String(source), values: [...parameters] } : String(source);
    values.set(name, binding);
    ownedAttributes.set(node, values);
    node.setAttribute(name, renderAttribute(binding));
  }

  function renderParts(parts) {
    return parts.map((part) => typeof part === 'string' ? part : translate(part.ui)).join('');
  }

  function setParts(node, parts) {
    ownedParts.set(node, parts);
    node.textContent = renderParts(parts);
  }

  function setPhotoPlaceholder(image) {
    placeholderImages.add(image);
    image.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<rect width="64" height="64" fill="#f0f0f0"/>' +
      '<text x="32" y="36" font-size="11" text-anchor="middle" fill="#333">' +
      translate('No photo') + '</text></svg>');
  }

  // All data-filled elements are initially empty. Capture static text now,
  // before the main script can add the user's containers, categories or items.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, svg, [data-language-choices]')) continue;
    if (/[A-Za-z]/.test(node.nodeValue)) staticText.set(node, node.nodeValue);
  }
  for (const element of document.querySelectorAll('[placeholder], [aria-label], [title], img[alt]')) {
    for (const attribute of ['placeholder', 'aria-label', 'title', 'alt']) {
      if (element.hasAttribute(attribute)) setAttribute(element, attribute, element.getAttribute(attribute));
    }
  }

  function apply() {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    for (const [textNode, original] of staticText) {
      if (!textNode.isConnected) { staticText.delete(textNode); continue; }
      const leading = original.match(/^\s*/)[0];
      const trailing = original.match(/\s*$/)[0];
      textNode.nodeValue = language === 'en'
        ? original
        : leading + translate(normalize(original)) + trailing;
    }
    for (const [element, original] of ownedText) {
      if (!element.isConnected) { ownedText.delete(element); continue; }
      element.textContent = translate(original);
    }
    for (const [element, parts] of ownedParts) {
      if (!element.isConnected) { ownedParts.delete(element); continue; }
      element.textContent = renderParts(parts);
    }
    for (const [element, attributes] of ownedAttributes) {
      if (!element.isConnected) { ownedAttributes.delete(element); continue; }
      for (const [attribute, original] of attributes) element.setAttribute(attribute, renderAttribute(original));
    }
    for (const image of placeholderImages) {
      if (!image.isConnected) { placeholderImages.delete(image); continue; }
      setPhotoPlaceholder(image);
    }
    const picker = document.getElementById('settings-language');
    if (picker) picker.value = language;
  }

  function setLanguage(next) {
    if (!languages.includes(next)) return;
    language = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch (_) { /* Session only. */ }
    apply();
  }

  window.FindItI18n = {
    translate, setText, setParts, setAttribute, setLanguage, setPhotoPlaceholder,
    getLanguage: () => language,
    forgetText: (element) => ownedText.delete(element),
  };
  const picker = document.getElementById('settings-language');
  if (picker) picker.addEventListener('change', () => setLanguage(picker.value));
  apply();
  // Rendering replaces list rows frequently. Release detached bindings after
  // each batch, without observing or translating any newly inserted user data.
  new MutationObserver((records) => {
    if (!records.some((record) => record.removedNodes.length)) return;
    for (const map of [staticText, ownedText, ownedParts, ownedAttributes]) {
      for (const element of map.keys()) if (!element.isConnected) map.delete(element);
    }
    for (const image of placeholderImages) if (!image.isConnected) placeholderImages.delete(image);
  }).observe(document.body, { childList: true, subtree: true });
})();
