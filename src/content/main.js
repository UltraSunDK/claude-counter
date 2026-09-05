(() => {
	'use strict';

	const CC = (globalThis.ClaudeCounter = globalThis.ClaudeCounter || {});
	if (CC.__started) return;
	CC.__started = true;

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

	/**
	 * Wait for an element to appear in the DOM using MutationObserver.
	 * More efficient than polling - reacts immediately when element appears.
	 * @param {string} selector - CSS selector
	 * @param {number} [timeoutMs] - Optional timeout in ms. Returns null if timeout expires.
	 */
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

	function observeUrlChanges(callback) {
		let lastPath = window.location.pathname;

		const fireIfChanged = () => {
			const current = window.location.pathname;
			if (current !== lastPath) {
				lastPath = current;
				callback();
			}
		};

		// Listen for custom event from bridge (history methods wrapped early)
		window.addEventListener('cc:urlchange', fireIfChanged);
		// Also popstate for back/forward buttons
		window.addEventListener('popstate', fireIfChanged);

		return () => {
			window.removeEventListener('cc:urlchange', fireIfChanged);
			window.removeEventListener('popstate', fireIfChanged);
		};
	}

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

	let usageState = null; // last snapshot
	let usageResetMs = { five_hour: null, seven_day: null }; // cached parsed timestamps
	let lastUsageSseMs = 0;
	let usageFetchInFlight = false;
	let lastUsageUpdateMs = 0;
	const rolloverHandledForResetMs = { five_hour: null, seven_day: null };

	const ui = new CC.ui.CounterUI({
		onUsageRefresh: async () => {
			await refreshUsage();
		}
	});
	ui.initialize();

	// Bridge must be ready before we can make requests
	const bridgeReady = CC.injectBridgeOnce();

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
		// Cache parsed timestamps to avoid Date.parse() every tick
		usageResetMs.five_hour = normalized.five_hour?.resets_at ? Date.parse(normalized.five_hour.resets_at) : null;
		usageResetMs.seven_day = normalized.seven_day?.resets_at ? Date.parse(normalized.seven_day.resets_at) : null;
		ui.setUsage(normalized);
	}

	function updateOrgIdIfNeeded(newOrgId) {
		if (newOrgId && typeof newOrgId === 'string' && newOrgId !== currentOrgId) {
			currentOrgId = newOrgId;
		}
	}

	async function refreshUsage() {
		await bridgeReady;
		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		if (usageFetchInFlight) return;
		usageFetchInFlight = true;
		let raw;
		try {
			raw = await CC.bridge.requestUsage(orgId);
		} catch {
			return;
		} finally {
			usageFetchInFlight = false;
		}

		const parsed = parseUsageFromUsageEndpoint(raw);
		applyUsageUpdate(parsed, 'usage');
	}

	async function refreshConversation() {
		await bridgeReady;
		if (!currentConversationId) {
			ui.setConversationMetrics();
			return;
		}

		const orgId = currentOrgId || getOrgIdFromCookie();
		if (!orgId) return;
		updateOrgIdIfNeeded(orgId);

		try {
			await CC.bridge.requestConversation(orgId, currentConversationId);
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

	CC.bridge.on('cc:generation_start', handleGenerationStart);
	CC.bridge.on('cc:conversation', handleConversationPayload);
	CC.bridge.on('cc:message_limit', handleMessageLimit);

	async function handleUrlChange() {
		currentConversationId = getConversationId();

		// Attach usage line and header independently - they have different anchor elements
		// and the header anchor doesn't exist on home/new pages
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

		// Best-effort orgId from cookie.
		updateOrgIdIfNeeded(getOrgIdFromCookie());

		await refreshConversation();

		// Usage is org-level, not conversation-level. Only fetch on first load or if stale.
		if (!usageState) await refreshUsage();
	}

	const unobserveUrl = observeUrlChanges(handleUrlChange);
	window.addEventListener('beforeunload', unobserveUrl);

	// Refresh on branch navigation - watch for the branch indicator to change
	let branchObserver = null;
	document.addEventListener('click', (e) => {
		if (!currentConversationId) return;
		const btn = e.target.closest('button[aria-label="Previous"], button[aria-label="Next"]');
		if (!btn) return;

		// Find the branch indicator span (matches "X / Y" pattern) near the clicked button
		const container = btn.closest('.inline-flex');
		const spans = container?.querySelectorAll('span') || [];
		const indicator = Array.from(spans).find((s) => /^\d+\s*\/\s*\d+$/.test(s.textContent.trim()));
		if (!indicator) return;

		const originalText = indicator.textContent;

		// Clean up any existing observer
		if (branchObserver) branchObserver.disconnect();

		// Watch for the indicator text to change (with cleanup timeout)
		branchObserver = new MutationObserver(() => {
			if (indicator.textContent !== originalText) {
				branchObserver.disconnect();
				branchObserver = null;
				refreshConversation();
			}
		});

		branchObserver.observe(indicator, { childList: true, characterData: true, subtree: true });

		// Clean up if nothing changes after 60 seconds
		setTimeout(() => {
			if (branchObserver) {
				branchObserver.disconnect();
				branchObserver = null;
			}
		}, 60000);
	});

	// Initial attach + fetches
	handleUrlChange();

	function tick() {
		ui.tick();

		// Refresh usage when a window ends (5h / 7d). SSE won't fire at rollover unless a message is sent.
		const now = Date.now();

		if (usageResetMs.five_hour && now >= usageResetMs.five_hour && rolloverHandledForResetMs.five_hour !== usageResetMs.five_hour) {
			rolloverHandledForResetMs.five_hour = usageResetMs.five_hour;
			refreshUsage();
		}
		if (usageResetMs.seven_day && now >= usageResetMs.seven_day && rolloverHandledForResetMs.seven_day !== usageResetMs.seven_day) {
			rolloverHandledForResetMs.seven_day = usageResetMs.seven_day;
			refreshUsage();
		}

		// Optional hourly safety refresh.
		const ONE_HOUR_MS = 60 * 60 * 1000;
		const sseAge = now - lastUsageSseMs;
		const anyAge = now - lastUsageUpdateMs;
		if (!document.hidden && sseAge > ONE_HOUR_MS && anyAge > ONE_HOUR_MS) {
			refreshUsage();
		}
	}

	// Keep countdowns + markers updated.
	setInterval(tick, 1000);
})();
