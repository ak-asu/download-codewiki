#!/usr/bin/env node
/**
 * Compatibility shim.
 *
 * `node scrape-codewiki.js <url>` keeps working; the implementation now lives
 * in bin/download-codewiki.js and no longer needs a headless browser.
 */
import { run } from './src/cli.js';

process.exitCode = await run(process.argv.slice(2));
