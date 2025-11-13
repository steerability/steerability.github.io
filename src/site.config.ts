import type { SiteConfig } from "@/types";
import type { AstroExpressiveCodeOptions } from "astro-expressive-code";

export const siteConfig: SiteConfig = {
	// Used as both a meta property & the generated OG image
	author: "Steerability",
	// Date.prototype.toLocaleDateString() parameters, found in src/utils/date.ts.
	date: {
		locale: "en-GB",
		options: {
			day: "numeric",
			month: "short",
			year: "numeric",
		},
	},
	// Default description meta property and webmanifest description
	description: "The Steerability lab site.",
	// HTML lang property
	lang: "en-GB",
	// Meta property
	ogLocale: "en_GB",
	/*
		- Used to construct the meta title property
		- The webmanifest name (via astro.config.ts)
		- The header link text
		- Footer text
	*/
	title: "AAAI 2026 Lab: Learning to Steer LLMs",
	url: "https://steerability.github.io/lab",
};

// Used to generate links in both the Header & Footer.
export const menuLinks = [
  { path: "/lab/", title: "Home" },
  { path: "/lab/about/", title: "About" },
  { path: "/lab/posts/", title: "Blog" },
  { path: "/lab/notes/", title: "Notes" },
];

// https://expressive-code.com/reference/configuration/
export const expressiveCodeOptions: AstroExpressiveCodeOptions = {
	styleOverrides: {
		borderRadius: "4px",
		codeFontFamily:
			'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Cou
