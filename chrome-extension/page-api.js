// MCP Browser Automation API
// This script is injected into pages to provide DOM manipulation helpers
// without violating CSP (no eval, no new Function)

if (!window.__mcpApiInstalled) {
  window.__mcpApiInstalled = true;

  const delay = ms => new Promise(r => setTimeout(r, ms));

  window.__mcpApi = {
    /**
     * Scroll the page with support for steps and delays
     * @param {Object} opts - Options: { to, steps, delayMs, smooth }
     */
    async scroll(opts) {
      const { to = 'bottom', percent, steps = 1, delayMs = 500, smooth = true } = opts || {};
      const behavior = smooth ? 'smooth' : 'auto';
      try { console.log('[MCP Scroll] opts:', { to, percent, steps, delayMs, smooth }); } catch {}

      function getScrollRoot() {
        const docRoot = document.scrollingElement || document.documentElement || document.body;
        const hasDocScroll = (docRoot && (docRoot.scrollHeight - docRoot.clientHeight) > 10);
        if (hasDocScroll) return docRoot;
        const preferred = ['main', '#main', '#content', '.content', '[role="main"]', 'body > div'];
        let best = null; let bestHeight = 0;
        const pushIfScrollable = (el) => {
          if (!el) return;
          const cs = getComputedStyle(el);
          const sh = el.scrollHeight, ch = el.clientHeight;
          if (sh - ch > 10 && /(auto|scroll)/i.test(cs.overflowY || '')) {
            if (sh > bestHeight) { best = el; bestHeight = sh; }
          }
        };
        try { preferred.forEach(sel => document.querySelectorAll(sel).forEach(pushIfScrollable)); } catch {}
        if (!best) {
          const all = document.querySelectorAll('*');
          const limit = Math.min(all.length, 2000);
          for (let i = 0; i < limit; i++) pushIfScrollable(all[i]);
        }
        return best || docRoot;
      }

      function computeHeights(root) {
        const fullHeight = Math.max(root.scrollHeight || 0, document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
        const viewport = root === document.body || root === document.documentElement || root === document.scrollingElement
          ? (window.innerHeight || document.documentElement.clientHeight || root.clientHeight || 0)
          : (root.clientHeight || 0);
        return { fullHeight, viewport };
      }

      const root = getScrollRoot();
      const { fullHeight, viewport } = computeHeights(root);
      try {
        const descr = root === document.body || root === document.documentElement || root === document.scrollingElement
          ? (root === document.body ? 'body' : (root === document.documentElement ? 'documentElement' : 'scrollingElement'))
          : (root.tagName.toLowerCase() + (root.id ? ('#' + root.id) : '') + (root.className ? ('.' + String(root.className).split(/\s+/).slice(0,2).join('.')) : ''));
        console.log('[MCP Scroll] root:', descr, 'fullHeight:', fullHeight, 'viewport:', viewport);
      } catch {}
      const targetForBottom = () => Math.max(0, fullHeight - viewport);
      const clampY = (y) => Math.max(0, Math.min(y, targetForBottom()));

      for (let i = 0; i < steps; i++) {
        try {
          if (typeof percent === 'number') {
            const p = Math.max(0, Math.min(100, percent)) / 100;
            const y = clampY(Math.round((fullHeight - viewport) * p));
            try { console.log('[MCP Scroll] step', i+1, '/', steps, 'percent ->', percent, 'y=', y); } catch {}
            if (root && root.scrollTo) root.scrollTo({ top: y, behavior });
            else window.scrollTo({ top: y, behavior });
          } else if (typeof to === 'number') {
            const y = clampY(to);
            try { console.log('[MCP Scroll] step', i+1, '/', steps, 'absolute ->', to, 'clamped=', y); } catch {}
            if (root && root.scrollTo) root.scrollTo({ top: y, behavior });
            else window.scrollTo({ top: y, behavior });
          } else if (to === 'top') {
            try { console.log('[MCP Scroll] step', i+1, '/', steps, 'top'); } catch {}
            if (root && root.scrollTo) root.scrollTo({ top: 0, behavior });
            else window.scrollTo({ top: 0, behavior });
          } else if (to === 'bottom') {
            const y = targetForBottom();
            try { console.log('[MCP Scroll] step', i+1, '/', steps, 'bottom y=', y); } catch {}
            if (root && root.scrollTo) root.scrollTo({ top: y, behavior });
            else window.scrollTo({ top: y, behavior });
          } else if (typeof to === 'string') {
            const el = document.querySelector(to);
            if (el && el.scrollIntoView) el.scrollIntoView({ behavior, block: 'start', inline: 'nearest' });
            try { console.log('[MCP Scroll] step', i+1, '/', steps, 'selector ->', to, 'found:', !!el); } catch {}
          }
        } catch {}
        if (i < steps - 1) await delay(delayMs);
      }
      try { console.log('[MCP Scroll] done'); } catch {}
      return true;
    },

    /**
     * Set input value and optionally press Enter
     * @param {string} sel - CSS selector
     * @param {string} value - Value to set
     * @param {Object} opts - Options: { pressEnter }
     */
    setInput(sel, value, opts = {}) {
      const { pressEnter = false } = opts;
      const el = document.querySelector(sel);
      if (!el) return false;

      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      if (pressEnter) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      }
      return true;
    },

    /**
     * Query elements and extract attributes
     * @param {string} selector - CSS selector
     * @param {Object} opts - Options: { attrs, limit, includeHidden }
     */
    query(selector, opts = {}) {
      const { attrs = ['textContent', 'href', 'value'], limit = 100, includeHidden = false } = opts;

      let elements = Array.from(document.querySelectorAll(selector));

      if (!includeHidden) {
        elements = elements.filter(el => {
          return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        });
      }

      elements = elements.slice(0, limit);

      return elements.map(el => {
        const result = {};
        attrs.forEach(attr => {
          if (attr === 'textContent') {
            result[attr] = el.textContent.trim();
          } else {
            result[attr] = el.getAttribute(attr) || el[attr] || null;
          }
        });
        return result;
      });
    },

    /**
     * Get inner HTML of element
     * @param {string} sel - CSS selector
     */
    getHTML(sel) {
      const el = document.querySelector(sel);
      return el ? el.innerHTML : null;
    },

    /**
     * Get outer HTML of element
     * @param {string} sel - CSS selector
     */
    getOuterHTML(sel) {
      const el = document.querySelector(sel);
      return el ? el.outerHTML : null;
    },

    /**
     * Wait for element to appear
     * @param {string} sel - CSS selector
     * @param {Object} opts - Options: { timeoutMs, visible, intervalMs }
     */
    waitFor(sel, opts = {}) {
      const { timeoutMs = 10000, visible = false, intervalMs = 100 } = opts;

      return new Promise((resolve) => {
        const startTime = performance.now();

        const checkElement = () => {
          const el = document.querySelector(sel);
          const exists = el && (!visible ||
            (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0));

          if (exists) {
            clearInterval(intervalId);
            resolve(el);
          } else if (performance.now() - startTime > timeoutMs) {
            clearInterval(intervalId);
            resolve(null);
          }
        };

        const intervalId = setInterval(checkElement, intervalMs);
        checkElement(); // Check immediately
      });
    },

    /**
     * Fill form fields
     * @param {string} formSel - Form selector
     * @param {Object} fields - Field name/id to value mapping
     */
    fillForm(formSel, fields) {
      const form = document.querySelector(formSel);
      if (!form) return false;

      let filledCount = 0;

      Object.entries(fields).forEach(([name, value]) => {
        // Try multiple strategies to find the field
        let field = form.querySelector(`[name="${name}"]`) ||
                    form.querySelector(`#${name}`) ||
                    form.querySelector(`[id*="${name}"]`) ||
                    form.querySelector(`[name*="${name}"]`);

        // Try by label text
        if (!field) {
          const labels = Array.from(form.querySelectorAll('label'));
          const label = labels.find(l =>
            l.textContent.toLowerCase().includes(name.toLowerCase())
          );
          if (label && label.htmlFor) {
            field = form.querySelector(`#${label.htmlFor}`);
          }
        }

        if (field) {
          if (field.type === 'checkbox' || field.type === 'radio') {
            field.checked = !!value;
          } else if (field.tagName === 'SELECT') {
            field.value = value;
          } else {
            field.value = value;
          }

          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
          filledCount++;
        }
      });

      return filledCount > 0;
    },

    /**
     * Extract links with filtering
     * @param {string} containerSel - Container selector
     * @param {Object} opts - Options: { hrefContains, textContains, exclude, unique, limit }
     */
    extractLinks(containerSel, opts = {}) {
      const {
        hrefContains = null,
        textContains = null,
        exclude = [],
        unique = true,
        limit = 100
      } = opts;

      const container = document.querySelector(containerSel || 'body');
      if (!container) return { links: [], error: 'Container not found' };

      let links = Array.from(container.querySelectorAll('a[href]'));

      // Apply filters
      if (hrefContains) {
        links = links.filter(a => a.href.includes(hrefContains));
      }
      if (textContains) {
        links = links.filter(a => a.textContent.toLowerCase().includes(textContains.toLowerCase()));
      }

      // Apply exclusions
      if (exclude.length > 0) {
        links = links.filter(a => !exclude.some(pattern => a.href.includes(pattern)));
      }

      // Extract data
      let results = links.slice(0, limit).map(a => ({
        href: a.href,
        text: a.textContent.trim(),
        title: a.title || '',
        target: a.target || '_self'
      }));

      // Make unique if requested
      if (unique) {
        const seen = new Set();
        results = results.filter(link => {
          if (seen.has(link.href)) return false;
          seen.add(link.href);
          return true;
        });
      }

      return { links: results, count: results.length };
    },

    /**
     * Schema-based extraction
     * @param {string} containerSel - Container selector
     * @param {Object} schema - Field extraction schema
     * @param {number} limit - Max containers to process
     */
    extractSchema(containerSel, schema, limit = 100) {
      const containers = Array.from(document.querySelectorAll(containerSel)).slice(0, limit);

      const results = containers.map(container => {
        const item = {};

        Object.entries(schema).forEach(([fieldName, config]) => {
          const selector = config.selector || fieldName;
          const attr = config.attr || 'textContent';
          const multiple = config.multiple || false;

          if (multiple) {
            const elements = container.querySelectorAll(selector);
            item[fieldName] = Array.from(elements).map(el => {
              if (attr === 'textContent') {
                return el.textContent.trim();
              } else {
                return el.getAttribute(attr) || el[attr];
              }
            });
          } else {
            const element = container.querySelector(selector);
            if (element) {
              if (attr === 'textContent') {
                item[fieldName] = element.textContent.trim();
              } else {
                item[fieldName] = element.getAttribute(attr) || element[attr];
              }
            } else {
              item[fieldName] = null;
            }
          }
        });

        return item;
      });

      return { data: results, count: results.length };
    },

    /**
     * Get element text content
     * @param {string} sel - CSS selector
     */
    getText(sel) {
      const el = document.querySelector(sel);
      return el ? el.textContent.trim() : null;
    },

    /**
     * Check if element exists
     * @param {string} sel - CSS selector
     */
    exists(sel) {
      return !!document.querySelector(sel);
    },

    /**
     * Dismiss overlays (legacy support)
     * @param {Array} additionalSelectors - Additional selectors to try
     */
    dismissOverlays(additionalSelectors = []) {
      const commonSelectors = [
        '[aria-label*="close" i]',
        '[aria-label*="dismiss" i]',
        'button[class*="close" i]',
        'button[class*="dismiss" i]',
        '.modal-close',
        '.popup-close',
        '.overlay-close'
      ];

      const allSelectors = [...commonSelectors, ...additionalSelectors];
      let dismissed = 0;

      allSelectors.forEach(selector => {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          if (el.offsetWidth > 0 || el.offsetHeight > 0) {
            el.click();
            dismissed++;
          }
        });
      });

      return dismissed;
    },

    /**
     * Execute arbitrary user code in ISOLATED world without CSP violations
     * Uses ES module blob import - no eval() or new Function()
     * @param {string} code - User's JavaScript code
     * @param {Array} args - Optional arguments to pass
     */
    exec(code, args = []) {
      // Note: Many sites set CSP that blocks blob: or inline scripts. To avoid
      // CSP violations and noisy console errors, we do NOT attempt dynamic
      // import/eval here. Use the structured safe operations instead (query,
      // getHTML, waitFor, setInput, scroll, etc.).
      return Promise.reject(new Error('Safe exec disabled by CSP. Use method-based operations (api.query, api.getHTML, api.waitFor, api.scroll, etc.).'));
    }
  };

  console.log('[MCP API] Installed page API with', Object.keys(window.__mcpApi).length, 'methods');
}
