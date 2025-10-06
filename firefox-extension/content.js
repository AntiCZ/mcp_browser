// Firefox content script with console capture and message handling
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// Capture console logs
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

window.__consoleLogs = [];
const MAX_CONSOLE_LOGS = 1000;

console.log = function(...args) {
  window.__consoleLogs.push({ type: 'log', args, timestamp: Date.now() });
  if (window.__consoleLogs.length > MAX_CONSOLE_LOGS) {
    window.__consoleLogs = window.__consoleLogs.slice(-MAX_CONSOLE_LOGS);
  }
  originalLog.apply(console, args);
};

console.error = function(...args) {
  window.__consoleLogs.push({ type: 'error', args, timestamp: Date.now() });
  if (window.__consoleLogs.length > MAX_CONSOLE_LOGS) {
    window.__consoleLogs = window.__consoleLogs.slice(-MAX_CONSOLE_LOGS);
  }
  originalError.apply(console, args);
};

console.warn = function(...args) {
  window.__consoleLogs.push({ type: 'warn', args, timestamp: Date.now() });
  if (window.__consoleLogs.length > MAX_CONSOLE_LOGS) {
    window.__consoleLogs = window.__consoleLogs.slice(-MAX_CONSOLE_LOGS);
  }
  originalWarn.apply(console, args);
};

console.info = function(...args) {
  window.__consoleLogs.push({ type: 'info', args, timestamp: Date.now() });
  if (window.__consoleLogs.length > MAX_CONSOLE_LOGS) {
    window.__consoleLogs = window.__consoleLogs.slice(-MAX_CONSOLE_LOGS);
  }
  originalInfo.apply(console, args);
};

// Message handler for background script communication
browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Wrap in async function for better error handling
  (async () => {
    try {
      switch (request.action) {
        case 'executeSafeOperation': {
          const method = request.method;
          const args = Array.isArray(request.args) ? request.args : [];
          try {
            switch (method) {
              case 'scroll': {
                const [opts] = args;
                const { to = 'bottom', percent, steps = 1, delayMs = 500, smooth = true } = opts || {};
                const delay = (ms)=>new Promise(r=>setTimeout(r,ms));
                const behavior = smooth ? 'smooth' : 'auto';
                function getScrollRoot(){
                  const docRoot = document.scrollingElement || document.documentElement || document.body;
                  const hasDoc = (docRoot && (docRoot.scrollHeight - docRoot.clientHeight) > 10);
                  if (hasDoc) return docRoot;
                  const preferred = ['main','#main','#content','.content','[role="main"]','body > div'];
                  let best=null,bh=0;
                  const push=(el)=>{ if(!el) return; const cs=getComputedStyle(el); const sh=el.scrollHeight,ch=el.clientHeight; if(sh-ch>10 && /(auto|scroll)/i.test(cs.overflowY||'')){ if(sh>bh){best=el; bh=sh;} } };
                  try{ preferred.forEach(sel=>document.querySelectorAll(sel).forEach(push)); }catch{}
                  if(!best){ const all=document.querySelectorAll('*'); const lim=Math.min(all.length,2000); for(let i=0;i<lim;i++) push(all[i]); }
                  return best || docRoot;
                }
                const root = getScrollRoot();
                const fullHeight = Math.max(root.scrollHeight||0, document.body?.scrollHeight||0, document.documentElement?.scrollHeight||0);
                const viewport = (root===document.body||root===document.documentElement||root===document.scrollingElement) ? (window.innerHeight || document.documentElement.clientHeight || root.clientHeight || 0) : (root.clientHeight || 0);
                const targetForBottom = ()=>Math.max(0, fullHeight - viewport);
                const clampY = (y)=>Math.max(0, Math.min(y, targetForBottom()));
                for (let i=0;i<steps;i++){
                  try{
                    if (typeof percent === 'number') {
                      const p = Math.max(0, Math.min(100, percent)) / 100;
                      const y = clampY(Math.round((fullHeight - viewport) * p));
                      if (root && root.scrollTo) root.scrollTo({ top: y, behavior }); else window.scrollTo({ top: y, behavior });
                    } else if (typeof to === 'number') {
                      const y = clampY(to);
                      if (root && root.scrollTo) root.scrollTo({ top: y, behavior }); else window.scrollTo({ top: y, behavior });
                    } else if (to === 'top') {
                      if (root && root.scrollTo) root.scrollTo({ top: 0, behavior }); else window.scrollTo({ top: 0, behavior });
                    } else if (to === 'bottom') {
                      const y = targetForBottom();
                      if (root && root.scrollTo) root.scrollTo({ top: y, behavior }); else window.scrollTo({ top: y, behavior });
                    } else if (typeof to === 'string') {
                      const el = document.querySelector(to);
                      if (el && el.scrollIntoView) el.scrollIntoView({ behavior, block: 'start', inline: 'nearest' });
                    }
                  } catch {}
                  if (i < steps - 1) await delay(delayMs);
                }
                sendResponse({ success: true, result: true });
                break;
              }
              case 'query': {
                const [selector, opts] = args;
                const limit = opts?.limit ?? 100;
                const includeHidden = !!opts?.includeHidden;
                const attrs = Array.isArray(opts?.attrs) ? opts.attrs : ['textContent'];
                const elements = Array.from(document.querySelectorAll(selector || '*'))
                  .filter(el => includeHidden || isVisible(el))
                  .slice(0, limit)
                  .map(el => {
                    const out = {};
                    for (const a of attrs) {
                      if (a === 'textContent') out[a] = el.textContent?.trim() || '';
                      else if (a === 'html' || a === 'innerHTML') out[a] = el.innerHTML;
                      else if (a === 'outerHTML') out[a] = el.outerHTML;
                      else out[a] = el.getAttribute(a);
                    }
                    return out;
                  });
                sendResponse({ success: true, result: elements });
                break;
              }
              case 'getHTML': {
                const [selector] = args;
                const el = document.querySelector(selector);
                sendResponse({ success: true, result: el ? el.innerHTML : null });
                break;
              }
              case 'getOuterHTML': {
                const [selector] = args;
                const el = document.querySelector(selector);
                sendResponse({ success: true, result: el ? el.outerHTML : null });
                break;
              }
              default:
                sendResponse({ success: false, error: `Unsupported safe op: ${method}` });
            }
          } catch (opErr) {
            sendResponse({ success: false, error: String(opErr) });
          }
          break;
        }
        case 'detectPopups':
          // Use popup detector if available
          if (window.__popupDetector) {
            const result = window.__popupDetector.detectPopups();
            sendResponse(result);
          } else {
            sendResponse({ popupsDetected: false });
          }
          break;

        case 'checkClickType':
          // Check if element needs special click handling
          if (window.__clickDetection) {
            const element = window.__elementTracker?.getElementById(request.ref);
            if (element) {
              const analysis = window.__clickDetection.analyzeElement(element);
              sendResponse({
                needsTrustedClick: analysis.confidence > 0.5,
                isOAuth: analysis.reasons.includes('oauth'),
                opensNewWindow: analysis.reasons.includes('window.open'),
                confidence: analysis.confidence,
                reasons: analysis.reasons
              });
            } else {
              sendResponse({ needsTrustedClick: false });
            }
          } else {
            sendResponse({ needsTrustedClick: false });
          }
          break;

        case 'getElementUrl':
          // Get URL from element for opening in new tab
          const urlElement = window.__elementTracker?.getElementById(request.ref);
          if (urlElement) {
            const url = urlElement.href || urlElement.getAttribute('data-href') ||
                       urlElement.getAttribute('onclick')?.match(/window\.open\(['"]([^'"]+)['"]/)?.[1];
            sendResponse({ url });
          } else {
            sendResponse({ url: null });
          }
          break;

        case 'click':
          // Perform click action
          if (window.__elementValidator) {
            const result = await window.__elementValidator.click(request.ref, request.element);
            sendResponse(result);
          } else {
            // Fallback to basic click
            const element = window.__elementTracker?.getElementById(request.ref);
            if (element) {
              element.click();
              sendResponse({ success: true });
            } else {
              sendResponse({ success: false, error: 'Element not found' });
            }
          }
          break;

        case 'trustedClick':
          // Firefox trusted click simulation
          const trustedElement = window.__elementTracker?.getElementById(request.ref);
          if (trustedElement) {
            try {
              // Create and dispatch native mouse events
              const rect = trustedElement.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;

              const mouseDownEvent = new MouseEvent('mousedown', {
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                button: 0
              });

              const mouseUpEvent = new MouseEvent('mouseup', {
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                button: 0
              });

              const clickEvent = new MouseEvent('click', {
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y,
                button: 0
              });

              trustedElement.dispatchEvent(mouseDownEvent);
              trustedElement.dispatchEvent(mouseUpEvent);
              trustedElement.dispatchEvent(clickEvent);

              sendResponse({ success: true });
            } catch (clickError) {
              console.error('Trusted click error:', clickError);
              sendResponse({ success: false, error: clickError.message });
            }
          } else {
            sendResponse({ success: false, error: 'Element not found' });
          }
          break;

        case 'type':
          // Type text into element
          if (window.__elementValidator) {
            const result = await window.__elementValidator.type(
              request.ref,
              request.element,
              request.text,
              request.submit
            );
            sendResponse(result);
          } else {
            // Fallback to basic typing
            const element = window.__elementTracker?.getElementById(request.ref);
            if (element) {
              element.focus();
              element.value = request.text;
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));

              if (request.submit) {
                const form = element.closest('form');
                if (form) {
                  form.submit();
                } else {
                  element.dispatchEvent(new KeyboardEvent('keypress', {
                    key: 'Enter',
                    keyCode: 13,
                    bubbles: true
                  }));
                }
              }
              sendResponse({ success: true });
            } else {
              sendResponse({ success: false, error: 'Element not found' });
            }
          }
          break;

        case 'hover':
          // Hover over element
          if (window.__elementValidator) {
            const result = await window.__elementValidator.hover(request.ref, request.element);
            sendResponse(result);
          } else {
            const element = window.__elementTracker?.getElementById(request.ref);
            if (element) {
              const rect = element.getBoundingClientRect();
              const event = new MouseEvent('mouseover', {
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2
              });
              element.dispatchEvent(event);
              sendResponse({ success: true });
            } else {
              sendResponse({ success: false, error: 'Element not found' });
            }
          }
          break;

        case 'selectOption':
          // Select dropdown option
          if (window.__elementValidator) {
            const result = await window.__elementValidator.selectOption(
              request.ref,
              request.element,
              request.values
            );
            sendResponse(result);
          } else {
            const element = window.__elementTracker?.getElementById(request.ref);
            if (element && element.tagName === 'SELECT') {
              const values = Array.isArray(request.values) ? request.values : [request.values];

              // Clear previous selections if not multiple
              if (!element.multiple) {
                Array.from(element.options).forEach(opt => opt.selected = false);
              }

              // Select new values
              values.forEach(value => {
                const option = Array.from(element.options).find(
                  opt => opt.value === value || opt.text === value
                );
                if (option) {
                  option.selected = true;
                }
              });

              element.dispatchEvent(new Event('change', { bubbles: true }));
              sendResponse({ success: true });
            } else {
              sendResponse({ success: false, error: 'Element not found or not a select' });
            }
          }
          break;

        case 'pressKey':
          // Press keyboard key
          const keyEvent = new KeyboardEvent('keydown', {
            key: request.key,
            code: request.key,
            bubbles: true,
            cancelable: true
          });

          const activeElement = document.activeElement || document.body;
          activeElement.dispatchEvent(keyEvent);

          // Also dispatch keyup
          const keyUpEvent = new KeyboardEvent('keyup', {
            key: request.key,
            code: request.key,
            bubbles: true,
            cancelable: true
          });
          activeElement.dispatchEvent(keyUpEvent);

          sendResponse({ success: true });
          break;

        case 'getConsoleLogs':
          // Return captured console logs
          sendResponse({
            success: true,
            logs: window.__consoleLogs.map(log => ({
              type: log.type,
              timestamp: log.timestamp,
              args: log.args.map(arg => {
                try {
                  if (typeof arg === 'object') {
                    return JSON.stringify(arg);
                  }
                  return String(arg);
                } catch {
                  return String(arg);
                }
              })
            }))
          });
          break;

        case 'snapshot':
          // Generate accessibility snapshot
          if (window.__minimalEnhanced) {
            const result = await window.__minimalEnhanced.captureEnhanced({
              viewportOnly: request.viewportOnly,
              fullPage: request.fullPage,
              mode: request.mode
            });
            sendResponse({ success: true, snapshot: result });
          } else if (window.__scaffoldEnhanced && request.mode === 'scaffold') {
            const result = await window.__scaffoldEnhanced.captureScaffold();
            sendResponse({ success: true, snapshot: result });
          } else {
            // Fallback basic snapshot
            const snapshot = generateBasicSnapshot();
            sendResponse({ success: true, snapshot });
          }
          break;

        case 'executeCode':
          // Execute code safely using RPC executor
          if (window.__codeExecutorRPC) {
            const result = await window.__codeExecutorRPC.execute(
              request.code,
              request.timeout
            );
            sendResponse(result);
          } else {
            sendResponse({
              success: false,
              error: 'Code executor not available'
            });
          }
          break;

        case 'commonOperation':
          // Execute common operations
          const operations = {
            'hide_popups': hidePopups,
            'remove_ads': removeAds,
            'extract_all_text': extractAllText,
            'extract_all_links': extractAllLinks,
            'extract_all_images': extractAllImages,
            'highlight_interactive': highlightInteractive,
            'auto_fill_form': autoFillForm,
            'scroll_to_bottom': scrollToBottom,
            'expand_all_sections': expandAllSections
          };

          if (operations[request.operation]) {
            const result = await operations[request.operation](request.options);
            sendResponse({ success: true, result });
          } else {
            sendResponse({
              success: false,
              error: `Unknown operation: ${request.operation}`
            });
          }
          break;

        default:
          sendResponse({
            success: false,
            error: `Unknown action: ${request.action}`
          });
      }
    } catch (error) {
      console.error('Content script error:', error);
      sendResponse({
        success: false,
        error: error.message
      });
    }
  })();

  // Return true to indicate async response
  return true;
});

// Basic snapshot generation fallback
function generateBasicSnapshot() {
  const title = document.title;
  const url = window.location.href;
  let snapshot = `Page: ${title}\nURL: ${url}\n\n`;

  // Find interactive elements
  const interactiveSelectors = [
    'button',
    'a[href]',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[onclick]'
  ];

  interactiveSelectors.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el, index) => {
      const text = el.textContent?.trim() || el.value || el.placeholder || '';
      const role = el.tagName.toLowerCase();
      const ref = `ref${selector.replace(/[^\w]/g, '')}_${index}`;

      if (text || role === 'input') {
        snapshot += `${role} "${text}" [${ref}]\n`;
      }
    });
  });

  return snapshot;
}

// Common operations implementations
function hidePopups() {
  const popups = document.querySelectorAll(
    '[role="dialog"], .modal, .popup, .overlay, [class*="cookie"], [class*="consent"]'
  );
  let hidden = 0;
  popups.forEach(popup => {
    if (popup.offsetWidth > 0 && popup.offsetHeight > 0) {
      popup.style.display = 'none';
      hidden++;
    }
  });
  return { hiddenCount: hidden };
}

function removeAds() {
  const adSelectors = [
    '[class*="ad-"]',
    '[id*="ad-"]',
    '[class*="advertisement"]',
    'iframe[src*="doubleclick"]',
    'iframe[src*="googlesyndication"]'
  ];

  let removed = 0;
  adSelectors.forEach(selector => {
    document.querySelectorAll(selector).forEach(el => {
      el.remove();
      removed++;
    });
  });

  return { removedCount: removed };
}

function extractAllText() {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  const texts = [];
  let node;
  while (node = walker.nextNode()) {
    const text = node.textContent.trim();
    if (text && text.length > 1) {
      texts.push(text);
    }
  }

  return { text: texts.join(' ') };
}

function extractAllLinks() {
  const links = Array.from(document.querySelectorAll('a[href]')).map(a => ({
    text: a.textContent.trim(),
    href: a.href,
    target: a.target
  }));

  return { links };
}

function isVisible(el) {
  const cs = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
  if (rect.width === 0 && rect.height === 0) return false;
  return true;
}

function extractAllImages() {
  const images = Array.from(document.querySelectorAll('img')).map(img => ({
    src: img.src,
    alt: img.alt,
    width: img.naturalWidth,
    height: img.naturalHeight
  }));

  return { images };
}

function highlightInteractive() {
  const elements = document.querySelectorAll(
    'button, a, input, select, textarea, [role="button"], [onclick]'
  );

  elements.forEach(el => {
    el.style.outline = '2px solid red';
    el.style.outlineOffset = '2px';
  });

  return { highlightedCount: elements.length };
}

function autoFillForm() {
  const inputs = document.querySelectorAll('input, select, textarea');
  let filled = 0;

  inputs.forEach(input => {
    if (input.type === 'email') {
      input.value = 'test@example.com';
      filled++;
    } else if (input.type === 'text' && input.name?.includes('name')) {
      input.value = 'Test User';
      filled++;
    } else if (input.type === 'tel') {
      input.value = '1234567890';
      filled++;
    } else if (input.type === 'number') {
      input.value = '42';
      filled++;
    }

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  return { filledCount: filled };
}

function scrollToBottom() {
  window.scrollTo(0, document.body.scrollHeight);
  return { scrolled: true, height: document.body.scrollHeight };
}

function expandAllSections() {
  // Click all expand/collapse buttons
  const expandButtons = document.querySelectorAll(
    '[aria-expanded="false"], [class*="expand"], [class*="collapse"], details:not([open])'
  );

  let expanded = 0;
  expandButtons.forEach(el => {
    if (el.tagName === 'DETAILS') {
      el.open = true;
    } else {
      el.click();
    }
    expanded++;
  });

  return { expandedCount: expanded };
}

console.log('BrowserMCP Enhanced Firefox content script loaded');
