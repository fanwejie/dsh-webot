/**
 * Print snippets around regex matches in a file, for minified CSS/JS where every
 * rule sits on one enormous line and line-based grep is useless.
 *
 * Usage: node snippet.mjs <file> <regex> [padding] [max]
 */
import { readFileSync } from 'node:fs'

const [file, pattern, paddingArg, maxArg] = process.argv.slice(2)
if (!file || !pattern) {
  console.error('usage: node snippet.mjs <file> <regex> [padding] [max]')
  process.exit(2)
}
const padding = Number(paddingArg || 220)
const max = Number(maxArg || 8)

const text = readFileSync(file, 'utf8')
const re = new RegExp(pattern, 'g')
let count = 0
for (const match of text.matchAll(re)) {
  const start = Math.max(0, match.index - padding)
  const end = Math.min(text.length, match.index + match[0].length + padding)
  console.log(`--- match ${++count} @${match.index} ---`)
  console.log(text.slice(start, end).replace(/\s+/g, ' '))
  if (count >= max) break
}
if (count === 0) console.log('no match')
