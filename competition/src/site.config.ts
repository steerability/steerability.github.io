import type { SiteConfig } from "@/types";
import type { AstroExpressiveCodeOptions } from "astro-expressive-code";

export const siteConfig: SiteConfig = {
	author: "Steerability",

	date: {
		locale: "en-GB",
		options: {
			day: "numeric",
			month: "short",
			year: "numeric",
		},
	},

	description:
		"A NeurIPS 2026 competition on steering large language models: reduce sycophancy while preserving general capabilities.",
	lang: "en-GB",
	ogLocale: "en_GB",
	title: "NeurIPS 2026 Competition: The Steerability Challenge",

	url: "https://steerability.github.io/competition",
};

export const menuLinks = [
	// { path: "/", title: "Home" },
	// { path: "/about/", title: "About" },
	// { path: "/posts/", title: "Blog" },
	// { path: "/notes/", title: "Notes" },
];

export const expressiveCodeOptions: AstroExpressiveCodeOptions = {
	styleOverrides: {
		borderRadius: "4px",
		codeFontFamily:
			'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
		codeFontSize: "0.875rem",
		codeLineHeight: "1.7142857rem",
		codePaddingInline: "1rem",
		frames: { frameBoxShadowCssValue: "none" },
		uiLineHeight: "inherit",
	},

	themeCssSelector(theme, { styleVariants }) {
		if (styleVariants.length >= 2) {
			const baseTheme = styleVariants[0]?.theme;
			const altTheme = styleVariants.find((v) => v.theme.type !== baseTheme?.type)?.theme;
			if (theme === baseTheme || theme === altTheme)
				return `[data-theme='${theme.type}']`;
		}
		return `[data-theme="${theme.name}"]`;
	},

	themes: ["dracula", "github-light"],
	useThemedScrollbars: false,
};
