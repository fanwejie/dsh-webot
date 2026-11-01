/**
 * List paths inside an Electron asar archive that contain a substring.
 *
 * Usage: node asar-find.mjs <archive> <substring> [limit]
 */
import { readFileSync } from 'node:fs'

const [archive, needle, limitArg] = process.argv.slice(2)
if (!archive || !needle) {
  console.error('usage: node asar-find.mjs <archive> <substring> [limit]')
  process.exit(2)
}
const limit = Number(limitArg || 60)

const buffer = readFileSync(archive)
const headerSize = buffer.readUInt32LE(4)
const headerEnd = 8 + headerSize
const jsonStart = buffer.indexOf(0x7b, 8)
let jsonEnd = headerEnd
while (jsonEnd > jsonStart && buffer[jsonEnd - 1] === 0) jsonEnd -= 1
const header = JSON.parse(buffer.toString('utf8', jsonStart, jsonEnd))

const hits = []
walk(header, '')
function walk(node, prefix) {
  if (hits.length >= limit) return
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, prefix ? `${prefix}/${name}` : name)
    return
  }
  if (prefix.toLowerCase().includes(needle.toLowerCase())) hits.push(`${prefix}  (${node.size} bytes)`)
}

for (const hit of hits) console.log(hit)
if (hits.length === 0) console.log('no match')
if (hits.length >= limit) console.log(`(stopped at limit ${limit})`)
