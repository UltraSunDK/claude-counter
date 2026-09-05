// ==UserScript==
// @name         Claude Counter
// @namespace    https://github.com/UltraSunDK/claude-counter
// @version      0.4.2-userscript
// @description  Shows token count, cache timer, and usage bars on claude.ai.
// @homepageURL  https://github.com/UltraSunDK/claude-counter
// @supportURL   https://github.com/UltraSunDK/claude-counter/issues
// @downloadURL  https://raw.githubusercontent.com/UltraSunDK/claude-counter/main/userscript/claude-counter.user.js
// @updateURL    https://raw.githubusercontent.com/UltraSunDK/claude-counter/main/userscript/claude-counter.user.js
// @match        https://claude.ai/*
// @run-at       document-start
// @grant        none
// @require      https://unpkg.com/gpt-tokenizer@2.9.0/dist/o200k_base.js
// ==/UserScript==

(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__ccUserscriptWrapped) return;
	CC.__ccUserscriptWrapped = true;

	CC._ccInternal = CC._ccInternal || {};
	CC._ccInternal.onGenerationStart = CC._ccInternal.onGenerationStart || (() => {});
	CC._ccInternal.onConversationData = CC._ccInternal.onConversationData || (() => {});
	CC._ccInternal.onMessageLimit = CC._ccInternal.onMessageLimit || (() => {});
	CC._ccInternal.onUrlChange = CC._ccInternal.onUrlChange || (() => {});

	const originalFetch = window.fetch ? window.fetch.bind(window) : null;
	CC._ccInternal.originalFetch = originalFetch;

	const originalPushState = history.pushState.bind(history);
	const originalReplaceState = history.replaceState.bind(history);

	const dispatchUrlChange = () => {
		try {
			CC._ccInternal.onUrlChange();
		} catch {
			// ignore
		}
	};

	history.pushState = function (...args) {
		const result = originalPushState(...args);
		dispatchUrlChange();
		return result;
	};

	history.replaceState = function (...args) {
		const result = originalReplaceState(...args);
		dispatchUrlChange();
		return result;
	};

	window.addEventListener('popstate', dispatchUrlChange);

	if (originalFetch) {
		window.fetch = async (...args) => {
			const url = toAbsoluteUrl(args[0]);
			const opts = args[1] || {};
			const method = (opts.method || 'GET').toUpperCase();

			if (url && method === 'POST' && (url.includes('/completion') || url.includes('/retry_completion'))) {
				try {
					CC._ccInternal.onGenerationStart();
				} catch {
					// ignore
				}
			}

			const response = await originalFetch(...args);
			const contentType = response.headers.get('content-type') || '';
			if (contentType.includes('event-stream')) {
				handleEventStream(response);
			}

			if (url && url.includes('/chat_conversations/') && url.includes('tree=')) {
				const meta = getConversationMeta(url);
				if (meta) {
					handleConversationResponse(meta, response);
				}
			}

			return response;
		};
	}

	function toAbsoluteUrl(input) {
		if (typeof input === 'string') {
			if (input.startsWith('/')) return `https://claude.ai${input}`;
			return input;
		}
		if (input instanceof URL) return input.href;
		if (input instanceof Request) return input.url;
		return '';
	}

	function getConversationMeta(url) {
		const match = url.match(/^https:\/\/claude\.ai\/api\/organizations\/([^/]+)\/chat_conversations\/([^/?]+)/);
		return match ? { orgId: match[1], conversationId: match[2] } : null;
	}

	async function handleConversationResponse({ orgId, conversationId }, response) {
		try {
			const cloned = response.clone();
			const data = await cloned.json();
			CC._ccInternal.onConversationData({ orgId, conversationId, data });
		} catch {
			// ignore parse failures
		}
	}

	async function handleEventStream(response) {
		try {
			const cloned = response.clone();
			const reader = cloned.body?.getReader?.();
			if (!reader) return;
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r\n|\r|\n/);
				buffer = lines.pop() || '';
				for (const line of lines) {
					if (!line.startsWith('data:')) continue;
					const raw = line.slice(5).trim();
					if (!raw) continue;
					try {
						const json = JSON.parse(raw);
						if (json?.type === 'message_limit' && json.message_limit) {
							CC._ccInternal.onMessageLimit(json.message_limit);
						}
					} catch {
						// ignore
					}
				}
			}
		} catch {
			// best-effort; do not break claude.ai
		}
	}
})();

(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	CC.DOM = Object.freeze({
		// Header (tokens + cache timer) anchors
		CHAT_MENU_TRIGGER: '[data-testid="chat-menu-trigger"]', // legacy
		CHAT_TITLE_SPLIT: '[data-testid="chat-title-split"]', // 2026-09 header
		HEADER_ANCHOR: '[data-testid="chat-title-split"], [data-testid="chat-menu-trigger"]',
		CHAT_PROJECT_WRAPPER: '.chat-project-wrapper',
		// Usage row (session + weekly) anchors
		MODEL_SELECTOR_DROPDOWN: '[data-testid="model-selector-dropdown"]', // legacy
		COMPOSER_ACTIONS: '[data-cds="ChatComposerActions"]', // 2026-09 composer
		USAGE_LINE_ANCHOR: '[data-cds="ChatComposerActions"], [data-testid="model-selector-dropdown"]',
		BRIDGE_SCRIPT_ID: 'cc-bridge-script'
	});

	CC.CONST = Object.freeze({
		CACHE_WINDOW_MS: 5 * 60 * 1000,
		CONTEXT_LIMIT_TOKENS: 200000
	});

	CC.COLORS = Object.freeze({
		PROGRESS_FILL_DARK: '#2c84db',
		PROGRESS_FILL_LIGHT: '#5aa6ff',
		PROGRESS_OUTLINE_DARK: '#787877',
		PROGRESS_OUTLINE_LIGHT: '#bfbfbf',
		PROGRESS_MARKER_DARK: '#ffffff',
		PROGRESS_MARKER_LIGHT: '#111111',
		RED_WARNING: '#ce2029',
		BOLD_LIGHT: '#141413',
		BOLD_DARK: '#faf9f5'
	});
})();



(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	const ROOT_MESSAGE_ID = '00000000-0000-4000-8000-000000000000';

	function stableStringify(value) {
		const seen = new WeakSet();

		const normalize = (v) => {
			if (v === null || typeof v !== 'object') return v;
			if (seen.has(v)) return '[Circular]';
			seen.add(v);

			if (Array.isArray(v)) return v.map(normalize);

			const out = {};
			for (const key of Object.keys(v).sort()) {
				out[key] = normalize(v[key]);
			}
			return out;
		};

		try {
			return JSON.stringify(normalize(value));
		} catch {
			return '';
		}
	}

	function getTokenizer() {
		return globalThis.GPTTokenizer_o200k_base || null;
	}

	function countTokens(text) {
		if (!text) return 0;
		const tokenizer = getTokenizer();
		if (!tokenizer?.countTokens) return 0;
		try {
			return tokenizer.countTokens(text);
		} catch {
			return 0;
		}
	}

	function buildTrunk(conversation) {
		const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
		const byId = new Map();
		for (const msg of messages) {
			if (msg?.uuid) byId.set(msg.uuid, msg);
		}

		const leaf = conversation?.current_leaf_message_uuid;
		if (!leaf) return [];

		const trunk = [];
		let currentId = leaf;
		while (currentId && currentId !== ROOT_MESSAGE_ID) {
			const msg = byId.get(currentId);
			if (!msg) break;
			trunk.push(msg);
			currentId = msg.parent_message_uuid;
		}

		trunk.reverse();
		return trunk;
	}

	function isCountableContentItem(item) {
		if (!item || typeof item !== 'object') return false;
		if (typeof item.type !== 'string') return false;
		if (item.type === 'thinking' || item.type === 'redacted_thinking') return false;
		if (item.type === 'image' || item.type === 'document') return false;
		return true;
	}

	function stringifyCountableContentItem(item) {
		if (!isCountableContentItem(item)) return '';

		// Common fast-path for text blocks.
		if (item.type === 'text' && typeof item.text === 'string') return item.text;

		// Tool blocks: include observable payloads deterministically, but exclude "thinking".
		if (item.type === 'tool_use') {
			const minimal = {
				id: item.id,
				name: item.name,
				input: item.input
			};
			return stableStringify(minimal);
		}

		if (item.type === 'tool_result') {
			const minimal = {
				tool_use_id: item.tool_use_id,
				is_error: item.is_error,
				content: item.content
			};
			return stableStringify(minimal);
		}

		// Fallback: keep only known-ish textual fields to avoid pulling in huge binary-ish blobs.
		const minimal = {};
		if (typeof item.text === 'string') minimal.text = item.text;
		if (typeof item.title === 'string') minimal.title = item.title;
		if (typeof item.url === 'string') minimal.url = item.url;
		if (typeof item.content === 'string') minimal.content = item.content;
		if (Array.isArray(item.content)) minimal.content = item.content;
		if (Object.keys(minimal).length === 0) return '';
		return stableStringify(minimal);
	}

	function stringifyMessageCountables(message) {
		const parts = [];

		// Message content blocks (primary source for tools, text, etc).
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			const s = stringifyCountableContentItem(item);
			if (s) parts.push(s);
		}

		// Attachment extracted content (observable, already text).
		const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
		for (const a of attachments) {
			if (typeof a?.extracted_content === 'string' && a.extracted_content) {
				parts.push(a.extracted_content);
			}
		}

		return parts.join('\n');
	}

	async function hashString(str) {
		if (!crypto?.subtle?.digest) return null;
		try {
			const data = new TextEncoder().encode(str);
			const buffer = await crypto.subtle.digest('SHA-256', data);
			const bytes = new Uint8Array(buffer);
			// Use first 8 bytes (64 bits) for fingerprint
			return Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
		} catch {
			return null;
		}
	}

	async function fingerprint(text) {
		if (!text) return null;
		const hash = await hashString(text);
		if (!hash) return null;
		return `${text.length}:${hash}`;
	}

	class TokenCache {
		constructor() {
			this._byMessageId = new Map(); // uuid -> { fp, tokens }
		}

		async getMessageTokens(messageId, messageText) {
			const fp = await fingerprint(messageText);
			if (!fp) return countTokens(messageText);
			const cached = this._byMessageId.get(messageId);
			if (cached && cached.fp === fp) return cached.tokens;

			const tokens = countTokens(messageText);
			this._byMessageId.set(messageId, { fp, tokens });
			return tokens;
		}

		pruneToMessageIds(keepIds) {
			const keep = new Set(keepIds);
			for (const id of this._byMessageId.keys()) {
				if (!keep.has(id)) this._byMessageId.delete(id);
			}
		}
	}

	const tokenCache = new TokenCache();

	async function computeConversationMetrics(conversation) {
		const trunk = buildTrunk(conversation);
		const trunkIds = trunk.map((m) => m.uuid).filter(Boolean);
		tokenCache.pruneToMessageIds(trunkIds);

		let totalTokens = 0;
		let lastAssistantMs = null;

		for (const msg of trunk) {
			if (msg?.sender === 'assistant' && msg?.created_at) {
				const msgMs = Date.parse(msg.created_at);
				if (!lastAssistantMs || msgMs > lastAssistantMs) {
					lastAssistantMs = msgMs;
				}
			}

			const msgText = stringifyMessageCountables(msg);
			const msgTokens = msg?.uuid ? await tokenCache.getMessageTokens(msg.uuid, msgText) : countTokens(msgText);
			totalTokens += msgTokens;
		}
		const cachedUntil = lastAssistantMs ? lastAssistantMs + CC.CONST.CACHE_WINDOW_MS : null;

		return {
			trunkMessageCount: trunk.length,
			totalTokens,
			lastAssistantMs,
			cachedUntil
		};
	}

	CC.tokens = { computeConversationMetrics };
})();


(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});

	function formatSeconds(totalSeconds) {
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	function formatResetCountdown(timestampMs) {
		// <= 0: reset time reached
		const diffMs = timestampMs - Date.now();
		if (diffMs <= 0) return '0s';

		// < 1 min: show seconds
		const totalSeconds = Math.floor(diffMs / 1000);
		if (totalSeconds < 60) return `${totalSeconds}s`;

		// < 1 hour: show minutes
		const totalMinutes = Math.round(totalSeconds / 60);
		if (totalMinutes < 60) return `${totalMinutes}m`;

		// < 1 day: show hours
		const hours = Math.floor(totalMinutes / 60);
		const minutes = totalMinutes % 60;
		if (hours < 24) return `${hours}h ${minutes}m`;

		// >= 1 day: show days
		const days = Math.floor(hours / 24);
		const remHours = hours % 24;
		return `${days}d ${remHours}h`;
	}

	function setupTooltip(element, tooltip, { topOffset = 10 } = {}) {
		if (!element || !tooltip) return;
		if (element.hasAttribute('data-tooltip-setup')) return;
		element.setAttribute('data-tooltip-setup', 'true');
		element.classList.add('cc-tooltipTrigger');

		let pressTimer;
		let hideTimer;

		const show = () => {
			const rect = element.getBoundingClientRect();
			tooltip.style.opacity = '1';
			const tipRect = tooltip.getBoundingClientRect();

			let left = rect.left + rect.width / 2;
			if (left + tipRect.width / 2 > window.innerWidth) left = window.innerWidth - tipRect.width / 2 - 10;
			if (left - tipRect.width / 2 < 0) left = tipRect.width / 2 + 10;

			let top = rect.top - tipRect.height - topOffset;
			if (top < 10) top = rect.bottom + 10;

			tooltip.style.left = `${left}px`;
			tooltip.style.top = `${top}px`;
			tooltip.style.transform = 'translateX(-50%)';
		};

		const hide = () => {
			tooltip.style.opacity = '0';
			clearTimeout(hideTimer);
		};

		element.addEventListener('pointerdown', (e) => {
			if (e.pointerType === 'touch' || e.pointerType === 'pen') {
				pressTimer = setTimeout(() => {
					show();
					hideTimer = setTimeout(hide, 3000);
				}, 500);
			}
		});

		element.addEventListener('pointerup', () => clearTimeout(pressTimer));
		element.addEventListener('pointercancel', () => {
			clearTimeout(pressTimer);
			hide();
		});

		element.addEventListener('pointerenter', (e) => {
			if (e.pointerType === 'mouse') show();
		});

		element.addEventListener('pointerleave', (e) => {
			if (e.pointerType === 'mouse') hide();
		});
	}

	function makeTooltip(text) {
		const tip = document.createElement('div');
		tip.className = 'bg-bg-500 text-text-000 cc-tooltip';
		tip.textContent = text;
		document.body.appendChild(tip);
		return tip;
	}

	class CounterUI {
		constructor({ onUsageRefresh } = {}) {
			this.onUsageRefresh = onUsageRefresh || null;

			this.headerContainer = null;
			this.headerDisplay = null;
			this.lengthGroup = null;
			this.lengthDisplay = null;
			this.cachedDisplay = null;
			this.lengthBar = null;
			this.lengthTooltip = null;
			this.lastCachedUntilMs = null;
			this.pendingCache = false;

			this.usageLine = null;
			this.usageMainRow = null;
			this.usageModelRow = null;
			this.usageWindows = null; // key -> { label, hours, group, span, bar, fill, marker, resetMs, windowStartMs }
			this.refreshingUsage = false;

			this.domObserver = null;
		}

		getProgressChrome() {
			const root = document.documentElement;
			const modeDark = root.dataset?.mode === 'dark';
			const modeLight = root.dataset?.mode === 'light';
			const isDark = modeDark && !modeLight;

			return {
				strokeColor: isDark ? CC.COLORS.PROGRESS_OUTLINE_DARK : CC.COLORS.PROGRESS_OUTLINE_LIGHT,
				fillColor: isDark ? CC.COLORS.PROGRESS_FILL_DARK : CC.COLORS.PROGRESS_FILL_LIGHT,
				markerColor: isDark ? CC.COLORS.PROGRESS_MARKER_DARK : CC.COLORS.PROGRESS_MARKER_LIGHT,
				boldColor: isDark ? CC.COLORS.BOLD_DARK : CC.COLORS.BOLD_LIGHT
			};
		}

		refreshProgressChrome() {
			const { strokeColor, fillColor, markerColor } = this.getProgressChrome();

			const applyBarChrome = (bar, { fillWarn } = {}) => {
				if (!bar) return;
				bar.style.setProperty('--cc-stroke', strokeColor);
				bar.style.setProperty('--cc-fill', fillColor);
				bar.style.setProperty('--cc-fill-warn', fillWarn ?? fillColor);
				bar.style.setProperty('--cc-marker', markerColor);
			};

			applyBarChrome(this.lengthBar, { fillWarn: fillColor });
			for (const win of Object.values(this.usageWindows || {})) {
				applyBarChrome(win.bar, { fillWarn: CC.COLORS.RED_WARNING });
			}
		}

		initialize() {
			// Header container (tokens + cache timer)
			this.headerContainer = document.createElement('div');
			this.headerContainer.className = 'text-text-500 text-xs !px-1 shrink-0 cc-header';

			this.headerDisplay = document.createElement('span');
			this.headerDisplay.className = 'cc-headerItem';

			this.lengthGroup = document.createElement('span');
			this.lengthDisplay = document.createElement('span');
			this.cachedDisplay = document.createElement('span');
			this.cacheTimeSpan = null; // reference to inner time span

			this.lengthGroup.appendChild(this.lengthDisplay);
			this.headerDisplay.appendChild(this.lengthGroup);

			// Usage line (session + weekly)
			this._initUsageLine();

			this._setupTooltips();
			this._observeDom();
			this._observeTheme();
		}

		_observeTheme() {
			// Watch for theme changes (data-mode attribute on <html>)
			const observer = new MutationObserver(() => this.refreshProgressChrome());
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
		}

		_observeDom() {
			// Track pending reattach attempts independently
			let usageReattachPending = false;
			let headerReattachPending = false;

			this.domObserver = new MutationObserver(() => {
				const usageMissing = this.usageLine && !document.contains(this.usageLine);
				const headerMissing = !document.contains(this.headerContainer);

				if (usageMissing && !usageReattachPending) {
					usageReattachPending = true;
					CC.waitForElement(CC.DOM.USAGE_LINE_ANCHOR, 60000).then((el) => {
						usageReattachPending = false;
						if (el) this.attachUsageLine();
					});
				}

				if (headerMissing && !headerReattachPending) {
					headerReattachPending = true;
					CC.waitForElement(CC.DOM.HEADER_ANCHOR, 60000).then((el) => {
						headerReattachPending = false;
						if (el) this.attachHeader();
					});
				}
			});
			this.domObserver.observe(document.body, { childList: true, subtree: true });
		}

		_createUsageWindow({ key, label, hours, textFirst }) {
			const span = document.createElement('span');
			span.className = 'cc-usageText';

			const bar = document.createElement('div');
			bar.className = 'cc-bar cc-bar--usage';
			const fill = document.createElement('div');
			fill.className = 'cc-bar__fill';
			const marker = document.createElement('div');
			marker.className = 'cc-bar__marker cc-hidden';
			marker.style.left = '0%';
			bar.appendChild(fill);
			bar.appendChild(marker);

			const group = document.createElement('div');
			group.className = `cc-usageGroup cc-usageGroup--${key} cc-hidden`;
			if (textFirst) {
				group.appendChild(span);
				group.appendChild(bar);
			} else {
				group.appendChild(bar);
				group.appendChild(span);
			}

			return { key, label, hours, group, span, bar, fill, marker, resetMs: null, windowStartMs: null };
		}

		_initUsageLine() {
			this.usageLine = document.createElement('div');
			this.usageLine.className = 'text-text-400 text-[11px] cc-usageRow cc-usageRows cc-hidden w-full';

			this.usageWindows = {
				session: this._createUsageWindow({ key: 'session', label: 'Session', hours: 5, textFirst: true }),
				weekly: this._createUsageWindow({ key: 'weekly', label: 'Weekly', hours: 24 * 7, textFirst: false }),
				// Model-scoped 7-day limit (e.g. Fable); only shown when the account reports one.
				// The label is replaced with the model's display name from the API.
				model: this._createUsageWindow({ key: 'model', label: 'Fable', hours: 24 * 7, textFirst: true })
			};

			// Row 1: session (left) + weekly (right). Row 2: model-scoped limit, full width.
			this.usageMainRow = document.createElement('div');
			this.usageMainRow.className = 'cc-usageLine';
			this.usageMainRow.appendChild(this.usageWindows.session.group);
			this.usageMainRow.appendChild(this.usageWindows.weekly.group);

			this.usageModelRow = document.createElement('div');
			this.usageModelRow.className = 'cc-usageLine cc-hidden';
			this.usageModelRow.appendChild(this.usageWindows.model.group);

			this.usageLine.appendChild(this.usageMainRow);
			this.usageLine.appendChild(this.usageModelRow);

			this.refreshProgressChrome();

			this.usageLine.addEventListener('click', async () => {
				if (!this.onUsageRefresh || this.refreshingUsage) return;
				this.refreshingUsage = true;
				this.usageLine.classList.add('cc-usageRow--dim');
				try {
					await this.onUsageRefresh();
				} finally {
					this.usageLine.classList.remove('cc-usageRow--dim');
					this.refreshingUsage = false;
				}
			});
		}

		_setupTooltips() {
			this.lengthTooltip = makeTooltip(
				"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nBecomes invalid after context compaction.\nBar scale: 200k tokens (Claude's maximum context length, will compact before then)."
			);
			setupTooltip(
				this.lengthGroup,
				this.lengthTooltip,
				{ topOffset: 8 }
			);

			setupTooltip(
				this.cachedDisplay,
				makeTooltip("Messages sent while cached are significantly cheaper."),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.usageWindows.session.group,
				makeTooltip("5-hour session window.\nThe bar shows your usage.\nThe line marks where you are in the window."),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.usageWindows.weekly.group,
				makeTooltip("7-day usage window.\nThe bar shows your usage.\nThe line marks where you are in the window."),
				{ topOffset: 8 }
			);

			setupTooltip(
				this.usageWindows.model.group,
				makeTooltip("7-day model-specific window (e.g. Fable).\nSeparate weekly limit for that model.\nThe bar shows your usage.\nThe line marks where you are in the window."),
				{ topOffset: 8 }
			);
		}

		attach() {
			this.attachHeader();
			this.attachUsageLine();
			this.refreshProgressChrome();
		}

		attachHeader() {
			const trigger = document.querySelector(CC.DOM.HEADER_ANCHOR);
			if (!trigger) return;
			// New header (2026-09): the title + "more options" buttons live in a flex
			// row tagged chat-title-split; the counter goes right after that row.
			// Legacy header: after the chat menu's project wrapper.
			const anchor = trigger.matches(CC.DOM.CHAT_TITLE_SPLIT)
				? trigger
				: trigger.closest(CC.DOM.CHAT_PROJECT_WRAPPER) || trigger.parentElement;
			if (!anchor) return;
			if (anchor.nextElementSibling !== this.headerContainer) {
				anchor.after(this.headerContainer);
			}
			this._renderHeader();
			this.refreshProgressChrome();
		}

		attachUsageLine() {
			if (!this.usageLine) return;
			// New composer (2026-09): the action buttons are absolutely positioned
			// inside a `relative` wrapper (attach bottom-left, send bottom-right).
			// That wrapper is a normal child of the composer card's column flex, so
			// the usage row goes right after it. Don't walk up from the model
			// selector: in open chats it lives in a footer row outside the card.
			const composerActions = document.querySelector(CC.DOM.COMPOSER_ACTIONS);
			const composerAnchor = composerActions?.parentElement;
			if (composerAnchor) {
				if (composerAnchor.nextElementSibling !== this.usageLine) {
					composerAnchor.after(this.usageLine);
				}
				this.refreshProgressChrome();
				return;
			}

			// Legacy composer: find the toolbar flex row that holds the buttons.
			const modelSelector = document.querySelector(CC.DOM.MODEL_SELECTOR_DROPDOWN);
			if (!modelSelector) return;
			const gridContainer = modelSelector.closest('[data-testid="chat-input-grid-container"]');
			const gridArea = modelSelector.closest('[data-testid="chat-input-grid-area"]');
			const findToolbarRow = (el, stopAt) => {
				let cur = el;
				while (cur && cur !== document.body) {
					if (stopAt && cur === stopAt) break;
					if (cur !== el && cur.nodeType === 1) {
						const style = window.getComputedStyle(cur);
						if (style.display === 'flex' && style.flexDirection === 'row') {
							const buttons = cur.querySelectorAll('button').length;
							if (buttons > 1) return cur;
						}
					}
					cur = cur.parentElement;
				}
				return null;
			};

			const toolbarRow =
				(gridContainer ? findToolbarRow(modelSelector, gridArea || gridContainer) : null) ||
				findToolbarRow(modelSelector) ||
				modelSelector.parentElement?.parentElement?.parentElement;
			if (!toolbarRow) return;
			if (toolbarRow.nextElementSibling !== this.usageLine) {
				toolbarRow.after(this.usageLine);
			}
			this.refreshProgressChrome();
		}

		setPendingCache(pending) {
			this.pendingCache = pending;
			if (this.cacheTimeSpan) {
				if (pending) {
					this.cacheTimeSpan.style.color = '';
				} else {
					const { boldColor } = this.getProgressChrome();
					this.cacheTimeSpan.style.color = boldColor;
				}
			}
		}

		setConversationMetrics({ totalTokens, cachedUntil } = {}) {
			this.pendingCache = false;

			if (typeof totalTokens !== 'number') {
				this.lengthDisplay.textContent = '';
				this.cachedDisplay.textContent = '';
				this.lastCachedUntilMs = null;
				this._renderHeader();
				return;
			}

			const pct = Math.max(0, Math.min(100, (totalTokens / CC.CONST.CONTEXT_LIMIT_TOKENS) * 100));
			this.lengthDisplay.textContent = `~${totalTokens.toLocaleString()} tokens`;

			// Mini bar (hide when full - context is definitely compacted by then)
			const isFull = pct >= 99.5;
			if (isFull) {
				this.lengthDisplay.style.opacity = '0.5';
				this.lengthBar = null;
				this.lengthGroup.replaceChildren(this.lengthDisplay);
				if (this.lengthTooltip) {
					this.lengthTooltip.textContent =
						"Approximate tokens (excludes system prompt).\nUses a generic tokenizer, may differ from Claude's count.\nThis count is invalid after compaction.";
				}
			} else {
				this.lengthDisplay.style.opacity = '';
				const bar = document.createElement('div');
				bar.className = 'cc-bar cc-bar--mini';
				this.lengthBar = bar;
				const fill = document.createElement('div');
				fill.className = 'cc-bar__fill';
				fill.style.width = `${pct}%`;
				bar.appendChild(fill);
				this.refreshProgressChrome();

				const barContainer = document.createElement('span');
				barContainer.className = 'inline-flex items-center';
				barContainer.appendChild(bar);

				this.lengthGroup.replaceChildren(this.lengthDisplay, document.createTextNode('\u00A0\u00A0'), barContainer);
			}

			// Cache timer
			const now = Date.now();
			if (typeof cachedUntil === 'number' && cachedUntil > now) {
				this.lastCachedUntilMs = cachedUntil;
				const secondsLeft = Math.max(0, Math.ceil((cachedUntil - now) / 1000));
				const { boldColor } = this.getProgressChrome();
				this.cacheTimeSpan = Object.assign(document.createElement('span'), {
					className: 'cc-cacheTime',
					textContent: formatSeconds(secondsLeft)
				});
				this.cacheTimeSpan.style.color = boldColor;
				this.cachedDisplay.replaceChildren(document.createTextNode('cached for\u00A0'), this.cacheTimeSpan);
			} else {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.cachedDisplay.textContent = '';
			}

			this._renderHeader();
		}

		_renderHeader() {
			this.headerContainer.replaceChildren();

			const hasTokens = !!this.lengthDisplay.textContent;
			const hasCache = !!this.cachedDisplay.textContent;

			if (!hasTokens) return;

			if (hasCache) {
				const gap = this.lengthBar ? '\u00A0\u00A0' : '\u00A0';
				this.headerDisplay.replaceChildren(
					this.lengthGroup,
					document.createTextNode(gap),
					this.cachedDisplay
				);
			} else {
				this.headerDisplay.replaceChildren(this.lengthGroup);
			}

			this.headerContainer.appendChild(this.headerDisplay);
		}

		setUsage(usage) {
			this.refreshProgressChrome();
			if (!this.usageWindows) return;

			const data = {
				session: usage?.five_hour || null,
				weekly: usage?.seven_day || null,
				model: usage?.seven_day_model || null
			};
			if (data.model?.label) this.usageWindows.model.label = data.model.label;

			const has = {};
			for (const [key, win] of Object.entries(this.usageWindows)) {
				has[key] = this._renderUsageWindow(win, data[key]);
			}

			this.usageLine?.classList.toggle('cc-hidden', !(has.session || has.weekly || has.model));
			this.usageMainRow?.classList.toggle('cc-hidden', !(has.session || has.weekly));
			this.usageWindows.session.group.classList.toggle('cc-usageGroup--single', has.session && !has.weekly);
			this.usageModelRow?.classList.toggle('cc-hidden', !has.model);

			this._updateMarkers();
		}

		_renderUsageWindow(win, w) {
			const has = !!(w && typeof w.utilization === 'number');
			win.group.classList.toggle('cc-hidden', !has);

			if (!has) {
				win.span.textContent = '';
				win.fill.style.width = '0%';
				win.fill.classList.remove('cc-warn', 'cc-full');
				win.resetMs = null;
				win.windowStartMs = null;
				return false;
			}

			const rawPct = w.utilization;
			const pct = Math.round(rawPct * 10) / 10;
			const resetMs = w.resets_at ? Date.parse(w.resets_at) : NaN;
			win.resetMs = Number.isFinite(resetMs) ? resetMs : null;
			win.windowStartMs = win.resetMs ? win.resetMs - win.hours * 60 * 60 * 1000 : null;
			const resetText = win.resetMs ? ` · resets in ${formatResetCountdown(win.resetMs)}` : '';
			win.span.textContent = `${win.label}: ${pct}%${resetText}`;

			const width = Math.max(0, Math.min(100, rawPct));
			win.fill.style.width = `${width}%`;
			win.fill.classList.toggle('cc-warn', width >= 90);
			win.fill.classList.toggle('cc-full', width >= 99.5);
			return true;
		}

		_updateMarkers() {
			const now = Date.now();
			for (const win of Object.values(this.usageWindows || {})) {
				if (win.windowStartMs && win.resetMs) {
					const total = win.resetMs - win.windowStartMs;
					const elapsed = Math.max(0, Math.min(total, now - win.windowStartMs));
					const ratio = total > 0 ? elapsed / total : 0;
					const pct = Math.max(0, Math.min(100, ratio * 100));
					win.marker.classList.remove('cc-hidden');
					win.marker.style.left = `${pct}%`;
				} else {
					win.marker.classList.add('cc-hidden');
				}
			}
		}

		tick() {
			// Cache countdown
			const now = Date.now();
			if (this.lastCachedUntilMs && this.lastCachedUntilMs > now) {
				const secondsLeft = Math.max(0, Math.ceil((this.lastCachedUntilMs - now) / 1000));
				if (this.cacheTimeSpan) {
					this.cacheTimeSpan.textContent = formatSeconds(secondsLeft);
				}
			} else if (this.lastCachedUntilMs && this.lastCachedUntilMs <= now) {
				this.lastCachedUntilMs = null;
				this.cacheTimeSpan = null;
				this.pendingCache = false;
				this.cachedDisplay.textContent = '';
				this._renderHeader();
			}

			// Reset countdown text + time markers
			for (const win of Object.values(this.usageWindows || {})) {
				if (!win.resetMs || !win.span.textContent) continue;
				const idx = win.span.textContent.indexOf('· resets in');
				if (idx !== -1) {
					const prefix = win.span.textContent.slice(0, idx + '· resets in '.length);
					win.span.textContent = `${prefix}${formatResetCountdown(win.resetMs)}`;
				}
			}

			this._updateMarkers();
		}
	}

	CC.ui = {
		CounterUI
	};
})();


(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__ccUserscriptStarted) return;
	CC.__ccUserscriptStarted = true;

	const STYLE_ID = 'cc-userscript-styles';
	const STYLES = '/* Header: tokens + cache timer */\n.cc-header {\n\tmargin-top: 2px;\n\tuser-select: none;\n}\n\n.cc-headerItem {\n\twhite-space: nowrap;\n}\n\n/* Usage rows: session + weekly (row 1), model-scoped limit e.g. Fable (row 2, only when available) */\n.cc-usageRow {\n\tposition: relative;\n\tz-index: 50;\n\tcursor: pointer;\n\tuser-select: none;\n\ttransition: opacity 150ms ease;\n}\n\n.cc-usageRows {\n\tdisplay: flex;\n\tflex-direction: column;\n\tgap: 4px;\n}\n\n.cc-usageLine {\n\tdisplay: flex;\n\tflex-direction: row;\n\talign-items: center;\n\tgap: 12px;\n\twidth: 100%;\n}\n\n.cc-usageRow--dim {\n\topacity: 0.6;\n}\n\n.cc-usageGroup {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 8px;\n\tflex: 1;\n\tmin-width: 0;\n}\n\n.cc-usageGroup--single {\n\twidth: 100%;\n}\n\n.cc-usageGroup--weekly {\n\tjustify-content: flex-end;\n}\n\n.cc-usageText {\n\twhite-space: nowrap;\n}\n\n/* Bars (mini + usage) */\n.cc-bar {\n\t--cc-radius: 3px;\n\t--cc-stroke: transparent;\n\t--cc-fill: transparent;\n\t--cc-fill-warn: var(--cc-fill);\n\t--cc-marker: transparent;\n\n\tposition: relative;\n\tbox-sizing: border-box;\n\twidth: 100%;\n\theight: 6px;\n\tborder-radius: var(--cc-radius);\n\tborder: 1px solid var(--cc-stroke);\n\toverflow: visible;\n\tuser-select: none;\n}\n\n.cc-bar__fill {\n\twidth: 0%;\n\theight: 100%;\n\tbackground: var(--cc-fill);\n\ttransition: width 300ms ease, background-color 300ms ease;\n\tborder-top-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-left-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-top-right-radius: 0;\n\tborder-bottom-right-radius: 0;\n}\n\n.cc-bar__fill.cc-full {\n\tborder-top-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n\tborder-bottom-right-radius: max(0px, calc(var(--cc-radius) - 1px));\n}\n\n.cc-bar__fill.cc-warn {\n\tbackground: var(--cc-fill-warn);\n}\n\n.cc-bar__marker {\n\tposition: absolute;\n\ttop: 0;\n\tbottom: 0;\n\tleft: 0%;\n\twidth: 2px;\n\tbackground: var(--cc-marker);\n\tpointer-events: none;\n}\n\n.cc-bar--mini {\n\twidth: 60px;\n\theight: 7px;\n\t--cc-radius: 2px;\n}\n\n.cc-bar--usage {\n\theight: 10px;\n\tflex: 1;\n}\n\n/* Tooltips */\n.cc-tooltip {\n\tposition: fixed;\n\tz-index: 9999;\n\tpadding: 4px 8px;\n\tborder-radius: 4px;\n\tfont-size: 12px;\n\twhite-space: pre-line;\n\tuser-select: none;\n\tpointer-events: none;\n\topacity: 0;\n\ttransition: opacity 200ms ease;\n}\n\n.cc-tooltipTrigger {\n\t-webkit-touch-callout: none;\n\t-webkit-user-select: none;\n\tuser-select: none;\n\tcursor: help;\n}\n\n/* Hide optional elements completely (no layout space) */\n.cc-hidden {\n\tdisplay: none !important;\n}\n';

	function injectStyles() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = STYLES;
		(document.head || document.documentElement).appendChild(style);
	}

	function getConversationId() {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}

	function getOrgIdFromCookie() {
		try {
			return document.cookie
				.split('; ')
				.find((row) => row.startsWith('lastActiveOrg='))
				?.split('=')[1] || null;
		} catch {
			return null;
		}
	}

	function waitForElement(selector, timeoutMs) {
		return new Promise((resolve) => {
			const existing = document.querySelector(selector);
			if (existing) {
				resolve(existing);
				return;
			}

			let timeoutId;
			const observer = new MutationObserver(() => {
				const el = document.querySelector(selector);
				if (el) {
					if (timeoutId) clearTimeout(timeoutId);
					observer.disconnect();
					resolve(el);
				}
			});

			observer.observe(document.body, { childList: true, subtree: true });

			if (timeoutMs) {
				timeoutId = setTimeout(() => {
					observer.disconnect();
					resolve(null);
				}, timeoutMs);
			}
		});
	}

	CC.waitForElement = waitForElement;

	// Model-scoped 7-day limit (e.g. Fable). /usage reports it in `limits[]` as
	//   { kind: "weekly_scoped", percent: 4, resets_at, scope: { model: { display_name: "Fable" } } }
	// Prefer Fable if several model-scoped limits exist; ignore surface-scoped ones (e.g. Cowork).
	function extractModelScopedLimit(limits) {
		if (!Array.isArray(limits)) return null;
		const scoped = limits.filter(
			(l) => l && l.kind === 'weekly_scoped' && l.scope?.model && !l.scope?.surface && typeof l.percent === 'number'
		);
		if (scoped.length === 0) return null;
		const pick = scoped.find((l) => /fable/i.test(l.scope.model.display_name || '')) || scoped[0];
		const utilization = Math.max(0, Math.min(100, pick.percent));
		const resets_at = typeof pick.resets_at === 'string' ? pick.resets_at : null;
		const label = typeof pick.scope.model.display_name === 'string' && pick.scope.model.display_name
			? pick.scope.model.display_name
			: 'Model';
		return { utilization, resets_at, window_hours: 24 * 7, label };
	}

	function parseUsageFromUsageEndpoint(raw) {
		if (!raw || typeof raw !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization));
			const resets_at = typeof w.resets_at === 'string' ? w.resets_at : null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.five_hour, 5);
		const sevenDay = normalizeWindow(raw.seven_day, 24 * 7);
		const model = extractModelScopedLimit(raw.limits);

		if (!fiveHour && !sevenDay && !model) return null;
		return { five_hour: fiveHour, seven_day: sevenDay, seven_day_model: model };
	}

	function parseUsageFromMessageLimit(raw) {
		if (!raw?.windows || typeof raw.windows !== 'object') return null;

		const normalizeWindow = (w, hours) => {
			if (!w || typeof w !== 'object') return null;
			if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
			const utilization = Math.max(0, Math.min(100, w.utilization * 100));
			const resets_at = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at)
				? new Date(w.resets_at * 1000).toISOString()
				: null;
			return { utilization, resets_at, window_hours: hours };
		};

		const fiveHour = normalizeWindow(raw.windows['5h'], 5);
		const sevenDay = normalizeWindow(raw.windows['7d'], 24 * 7);
		// Not observed in the SSE payload so far; picked up if it ever carries the same shape.
		const model = extractModelScopedLimit(raw.limits);

		if (!fiveHour && !sevenDay && !model) return null;
		return { five_hour: fiveHour, seven_day: sevenDay, seven_day_model: model };
	}

	let currentConversationId = null;
	let currentOrgId = null;

	let usageState = null;
	let usageResetMs = { five_hour: null, seven_day: null };
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			await refreshUsage();
		}
	});

	const originalFetch = CC._ccInternal?.originalFetch || (window.fetch ? window.fetch.bind(window) : null);

	function applyUsageUpdate(normalized, source) {
		if (!normalized) return;
		const now = Date.now();
		// The SSE message_limit event omits the model-scoped limit that /usage
		// reports. Keep the last known value rather than flashing it away; a
		// follow-up /usage fetch (see handleMessageLimit) brings it up to date.
		if (source === 'sse' && !normalized.seven_day_model && usageState?.seven_day_model) {
			normalized = { ...normalized, seven_day_model: usageState.seven_day_model };
		}
		usageState = normalized;
		lastUsageUpdateMs = now;
		if (source === 'sse') lastUsageSseMs = now;
		usageResetMs.five_hour = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;
		ui.setUsage(normalized);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	async function requestUsage(orgId) {
		if (!originalFetch) return null;
		const res = await originalFetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
			method: 'GET',
			credentials: 'include'
		});
		return await res.json();
	}

	async function requestConversation(orgId, conversationId) {
		if (!originalFetch) return null;
		const url = `https://claude.ai/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=true&rendering_mode=messages&render_all_tools=true`;
		const res = await originalFetch(url, {
			method: 'GET',
			credentials: 'include'
		});
		const json = await res.json();
		return json;
	}

	async function refreshUsage() {
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		let raw;
		try {
			raw = await requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}

		const parsed = parseUsageFromUsageEndpoint(raw);
		applyUsageUpdate(parsed, 'usage');
	}

	async function refreshConversation() {
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		try {
			const data = await requestConversation(orgId, currentConversationId);
			await handleConversationPayload({ orgId, conversationId: currentConversationId, data });
		} catch {
			// ignore
		}
	}

	function handleGenerationStart() {
		if (!currentConversationId) return;
		ui.setPendingCache(true);
	}

	async function handleConversationPayload({ orgId, conversationId, data }) {
		if (!conversationId || conversationId !== currentConversationId) return;
		updateOrgIdIfNeeded(orgId);
		if (!data) return;

		const metrics = await CC.tokens.computeConversationMetrics(data);
		ui.setConversationMetrics({ totalTokens: metrics.totalTokens, cachedUntil: metrics.cachedUntil });
	}

	let scopedRefreshTimer = null;
	function handleMessageLimit(messageLimit) {
		const parsed = parseUsageFromMessageLimit(messageLimit);
		applyUsageUpdate(parsed, 'sse');

		// The SSE event carries only the session + weekly windows. If the account
		// has a model-scoped limit (e.g. Fable), refresh /usage shortly after so
		// that bar moves too. Debounced so a burst of events costs one request.
		if (parsed && !parsed.seven_day_model && usageState?.seven_day_model) {
			clearTimeout(scopedRefreshTimer);
			scopedRefreshTimer = setTimeout(() => {
				scopedRefreshTimer = null;
				refreshUsage();
			}, 3000);
		}
	}

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		waitForElement(CC.DOM.USAGE_LINE_ANCHOR, 60000).then((el) => {
			if (el) ui.attachUsageLine();
		});
		waitForElement(CC.DOM.HEADER_ANCHOR, 60000).then((el) => {
			if (el) ui.attachHeader();
		});

		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();

		if (!usageState) await refreshUsage();
	}

	function tick() {
		ui.tick();

		const now = Date.now();
		if (usageResetMs.five_hour && now >= usageResetMs.five_hour && rolloverHandledForResetMs.five_hour !== usageResetMs.five_hour) {
			rolloverHandledForResetMs.five_hour = usageResetMs.five_hour;
			refreshUsage();
		}
		if (usageResetMs.seven_day && now >= usageResetMs.seven_day && rolloverHandledForResetMs.seven_day !== usageResetMs.seven_day) {
			rolloverHandledForResetMs.seven_day = usageResetMs.seven_day;
			refreshUsage();
		}

		const ONE_HOUR_MS = 60 * 60 * 1000;
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS) {
			refreshUsage();
		}
	}

	function start() {
		injectStyles();
		ui.initialize();
		CC._ccInternal.onGenerationStart = handleGenerationStart;
		CC._ccInternal.onConversationData = handleConversationPayload;
		CC._ccInternal.onMessageLimit = handleMessageLimit;
		CC._ccInternal.onUrlChange = handleUrlChange;

		handleUrlChange();
		setInterval(tick, 1000);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start, { once: true });
	} else {
		start();
	}
})();
