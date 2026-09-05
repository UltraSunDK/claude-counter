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
