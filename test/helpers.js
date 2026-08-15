import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const fixtureDir = new URL('./fixtures/', import.meta.url);

export function fixture(name) {
  const file = fileURLToPath(new URL(name, fixtureDir));
  if (name.endsWith('.gz')) return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  return fs.readFileSync(file, 'utf8');
}

export function fixtureJson(name) {
  return JSON.parse(fixture(name));
}

/** The opencode wiki, decoded. */
export function opencodeWiki() {
  return fixture('opencode-rpc.txt.gz');
}

/** All Graphviz sources captured from opencode, godot and playwright. */
export function dotCorpus() {
  return fixtureJson('dot-corpus.json.gz');
}
