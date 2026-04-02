#!/usr/bin/env node

/**
 * Headless Chrome wrapper for browser-tools
 * 
 * Usage:
 *   headless.js start [--profile]     Start headless Chrome
 *   headless.js stop                  Stop headless Chrome
 *   headless.js nav <url> [--new]     Navigate to URL
 *   headless.js screenshot            Take screenshot
 *   headless.js eval 'code'           Execute JavaScript
 *   headless.js content <url>         Extract page content as markdown
 *   headless.js cookies               Show cookies
 * 
 * Headless Chrome runs on port 9223 (separate from GUI Chrome on 9222)
 */

import { spawn, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const PORT = 9223;
const DATA_DIR = `${process.env.HOME}/.cache/browser-tools-headless`;

const [command, ...args] = process.argv.slice(2);

if (!command) {
	showHelp();
	process.exit(1);
}

async function main() {
	switch (command) {
		case "start":
			await cmdStart();
			break;
		case "stop":
			await cmdStop();
			break;
		case "nav":
			await cmdNav();
			break;
		case "screenshot":
			await cmdScreenshot();
			break;
		case "eval":
			await cmdEval();
			break;
		case "content":
			await cmdContent();
			break;
		case "cookies":
			await cmdCookies();
			break;
		case "help":
		case "--help":
		case "-h":
			showHelp();
			break;
		default:
			console.error(`✗ Unknown command: ${command}`);
			showHelp();
			process.exit(1);
	}
}

function showHelp() {
	console.log(`Headless Chrome wrapper for browser-tools

Usage: headless.js <command> [options]

Commands:
  start [--profile]   Start headless Chrome (port ${PORT})
  stop                Stop headless Chrome
  nav <url> [--new]   Navigate to URL
  screenshot          Take screenshot of current page
  eval 'code'         Execute JavaScript in page
  content <url>       Extract page content as markdown
  cookies             Show cookies for current page

Examples:
  headless.js start
  headless.js nav https://example.com
  headless.js screenshot
  headless.js eval "document.title"
  headless.js content https://example.com`);
}

async function isRunning() {
	try {
		const browser = await puppeteer.connect({
			browserURL: `http://localhost:${PORT}`,
			defaultViewport: null,
		});
		await browser.disconnect();
		return true;
	} catch {
		return false;
	}
}

async function connect(autoStart = true) {
	// Try to connect
	try {
		const browser = await Promise.race([
			puppeteer.connect({
				browserURL: `http://localhost:${PORT}`,
				defaultViewport: null,
			}),
			new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
		]);
		return browser;
	} catch {
		if (!autoStart) {
			throw new Error(`Headless Chrome not running. Run: headless.js start`);
		}
	}

	// Auto-start
	console.error("Starting headless Chrome...");
	await startHeadless(false);

	// Connect again
	const browser = await puppeteer.connect({
		browserURL: `http://localhost:${PORT}`,
		defaultViewport: null,
	});
	return browser;
}

async function startHeadless(useProfile) {
	execSync(`mkdir -p "${DATA_DIR}"`, { stdio: "ignore" });

	// Remove locks
	try {
		execSync(`rm -f "${DATA_DIR}/SingletonLock" "${DATA_DIR}/SingletonSocket" "${DATA_DIR}/SingletonCookie"`, { stdio: "ignore" });
	} catch {}

	if (useProfile) {
		execSync(
			`rsync -a --delete \
				--exclude='SingletonLock' \
				--exclude='SingletonSocket' \
				--exclude='SingletonCookie' \
				--exclude='*/Sessions/*' \
				--exclude='*/Current Session' \
				--exclude='*/Current Tabs' \
				--exclude='*/Last Session' \
				--exclude='*/Last Tabs' \
				"${process.env.HOME}/Library/Application Support/Google/Chrome/" "${DATA_DIR}/"`,
			{ stdio: "pipe" },
		);
	}

	spawn(
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		[
			"--headless=new",
			`--remote-debugging-port=${PORT}`,
			`--user-data-dir=${DATA_DIR}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-gpu",
			"--window-size=1920,1080",
		],
		{ detached: true, stdio: "ignore" },
	).unref();

	// Wait for ready
	for (let i = 0; i < 30; i++) {
		if (await isRunning()) return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("Failed to start headless Chrome");
}

// Commands

async function cmdStart() {
	const useProfile = args.includes("--profile");

	if (await isRunning()) {
		console.log(`✓ Headless Chrome already running on :${PORT}`);
		return;
	}

	if (useProfile) console.log("Syncing profile...");
	await startHeadless(useProfile);
	console.log(`✓ Headless Chrome started on :${PORT}${useProfile ? " with profile" : ""}`);
}

async function cmdStop() {
	try {
		const browser = await puppeteer.connect({
			browserURL: `http://localhost:${PORT}`,
			defaultViewport: null,
		});
		const proc = browser.process();
		await browser.close();
		if (proc) proc.kill();
		console.log("✓ Headless Chrome stopped");
	} catch {
		console.log("Headless Chrome not running");
	}
}

async function cmdNav() {
	const url = args.find((a) => !a.startsWith("--"));
	const newTab = args.includes("--new");

	if (!url) {
		console.error("Usage: headless.js nav <url> [--new]");
		process.exit(1);
	}

	const browser = await connect();
	const pages = await browser.pages();

	if (newTab || pages.length === 0) {
		const p = await browser.newPage();
		await p.goto(url, { waitUntil: "domcontentloaded" });
		console.log("✓ Opened:", url);
	} else {
		const p = pages.at(-1);
		await p.goto(url, { waitUntil: "domcontentloaded" });
		console.log("✓ Navigated to:", url);
	}

	await browser.disconnect();
}

async function cmdScreenshot() {
	const browser = await connect();
	const pages = await browser.pages();
	const p = pages.at(-1);

	if (!p) {
		console.error("✗ No active tab");
		process.exit(1);
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filepath = join(tmpdir(), `screenshot-${timestamp}.png`);
	await p.screenshot({ path: filepath });
	console.log(filepath);

	await browser.disconnect();
}

async function cmdEval() {
	const code = args.join(" ");
	if (!code) {
		console.error("Usage: headless.js eval 'code'");
		process.exit(1);
	}

	const browser = await connect();
	const pages = await browser.pages();
	const p = pages.at(-1);

	if (!p) {
		console.error("✗ No active tab");
		process.exit(1);
	}

	const result = await p.evaluate((c) => {
		const AsyncFunction = (async () => {}).constructor;
		return new AsyncFunction(`return (${c})`)();
	}, code);

	if (Array.isArray(result)) {
		for (let i = 0; i < result.length; i++) {
			if (i > 0) console.log("");
			for (const [key, value] of Object.entries(result[i])) {
				console.log(`${key}: ${value}`);
			}
		}
	} else if (typeof result === "object" && result !== null) {
		for (const [key, value] of Object.entries(result)) {
			console.log(`${key}: ${value}`);
		}
	} else {
		console.log(result);
	}

	await browser.disconnect();
}

async function cmdContent() {
	const url = args.find((a) => !a.startsWith("--"));
	if (!url) {
		console.error("Usage: headless.js content <url>");
		process.exit(1);
	}

	const browser = await connect();
	const pages = await browser.pages();
	let p = pages.at(-1);
	if (!p) p = await browser.newPage();

	await Promise.race([
		p.goto(url, { waitUntil: "networkidle2" }),
		new Promise((r) => setTimeout(r, 10000)),
	]).catch(() => {});

	const client = await p.createCDPSession();
	const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
	const { outerHTML } = await client.send("DOM.getOuterHTML", { nodeId: root.nodeId });
	await client.detach();

	const finalUrl = p.url();
	const doc = new JSDOM(outerHTML, { url: finalUrl });
	const reader = new Readability(doc.window.document);
	const article = reader.parse();

	function htmlToMarkdown(html) {
		const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
		turndown.use(gfm);
		turndown.addRule("removeEmptyLinks", {
			filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
			replacement: () => "",
		});
		return turndown
			.turndown(html)
			.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
			.replace(/ +/g, " ")
			.replace(/\s+,/g, ",")
			.replace(/\s+\./g, ".")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	let content;
	if (article?.content) {
		content = htmlToMarkdown(article.content);
	} else {
		const fallbackDoc = new JSDOM(outerHTML, { url: finalUrl });
		const fallbackBody = fallbackDoc.window.document;
		fallbackBody.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach((el) => el.remove());
		const main = fallbackBody.querySelector("main, article, [role='main'], .content, #content") || fallbackBody.body;
		const fallbackHtml = main?.innerHTML || "";
		content = fallbackHtml.trim().length > 100 ? htmlToMarkdown(fallbackHtml) : "(Could not extract content)";
	}

	console.log(`URL: ${finalUrl}`);
	if (article?.title) console.log(`Title: ${article.title}`);
	console.log("");
	console.log(content);

	await browser.disconnect();
}

async function cmdCookies() {
	const browser = await connect();
	const pages = await browser.pages();
	const p = pages.at(-1);

	if (!p) {
		console.error("✗ No active tab");
		process.exit(1);
	}

	const cookies = await p.cookies();
	for (const cookie of cookies) {
		console.log(`${cookie.name}: ${cookie.value}`);
		console.log(`  domain: ${cookie.domain}`);
		console.log(`  path: ${cookie.path}`);
		console.log(`  httpOnly: ${cookie.httpOnly}`);
		console.log(`  secure: ${cookie.secure}`);
		console.log("");
	}

	await browser.disconnect();
}

main().catch((e) => {
	console.error("✗", e.message);
	process.exit(1);
});
