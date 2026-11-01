/**
 * Extract one file out of an Electron asar archive.
 *
 * asar layout:
 *   [0..3]  uint32 LE  = 4 (pickle length of the header-size field)
 *   [4..7]  uint32 LE  = headerSize (bytes of the pickle starting at offset 8)
 *   [8..]   pickle: uint32 payloadSize, uint32 stringLength, JSON offsets table
 *   [8 + headerSize ..]  file data; the table's offsets are relative to it.
 *
 * Rather than hard-coding the JSON's byte position inside the pickle, this finds
 * the first `{` after the size fields and trims trailing NUL padding — the pickle
 * layout is an Electron implementation detail and has shifted between versions.
 *
 * Usage: node asar-extract.mjs <archive> <path/in/archive> <out-file>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [archive, innerPath, outFile] = process.argv.slice(2)
if (!archive || !innerPath || !outFile) {
  console.error('usage: node asar-extract.mjs <archive> <inner-path> <out-file>')
  process.exit(2)
}

const buffer = readFileSync(archive)
if (buffer.length < 16) throw new Error('not an asar archive: too short')

const headerSize = buffer.readUInt32LE(4)
const headerEnd = 8 + headerSize
const jsonStart = buffer.indexOf(0x7b, 8)
if (jsonStart < 0 || jsonStart >= headerEnd) throw new Error('no JSON header found')

let jsonEnd = headerEnd
while (jsonEnd > jsonStart && buffer[jsonEnd - 1] === 0) jsonEnd -= 1

const header = JSON.parse(buffer.toString('utf8', jsonStart, jsonEnd))
const dataStart = headerEnd

let node = header
for (const segment of innerPath.split('/').filter(Boolean)) {
  if (!node.files || !node.files[segment]) throw new Error(`not found: ${segment} in ${innerPath}`)
  node = node.files[segment]
}
if (node.files) throw new Error(`path is a directory: ${innerPath}`)
if (node.unpacked) throw new Error(`unpacked file, not in archive: ${innerPath}`)

const offset = Number(node.offset)
const size = Number(node.size)
writeFileSync(outFile, buffer.subarray(dataStart + offset, dataStart + offset + size))
console.log(`ok ${size} bytes -> ${outFile}`)
