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
