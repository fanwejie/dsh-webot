/**
 * Watch the desk for a while, and report how much the pointer actually moved.
 *
 * Windows exposes two facts, and neither answers the question alone:
 *
 * - `GetLastInputInfo` — when the last input of any kind happened. A bumped desk
 *   produces input too, so "any input" cancels a notification the user never saw.
 * - `GetCursorPos` — where the pointer is. One sample says nothing; the *path
 *   length* over the window is what separates a nudge from a person.
 *
 * So the window is sampled, and the answer is a distance. Sampling from Node would
 * mean one process launch per sample — 120 of them over 30 s. Instead a single
 * PowerShell process is started once and loops internally, returning one line when
 * the window closes.
 *
 * Keyboard activity is counted as well, as a sample count rather than a distance:
 * someone typing in an editor has not moved the pointer but is plainly at the desk,
 * and a distance-only rule would call them away.
 *
 * @module dsh-webot/presence
 */

import { spawn } from 'node:child_process'

/** ~4 pointer widths: a nudge is not a person, a reach for the mouse is. */
export const DEFAULT_TRAVEL_PX = 120

/** Sample spacing inside the window. */
const SAMPLE_MS = 250

/** A sample with input this recent counts as keyboard activity. */
const KEYBOARD_IDLE_MS = 1200

/** Samples this active means somebody is typing, not trembling. */
const KEYBOARD_SAMPLES = 4

const TYPE_DEFINITION = [
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class WebotDesk {',
  '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }',
  '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);',
  '  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);',
  '  public static uint IdleMs() {',
  '    LII i = new LII(); i.cbSize = (uint)Marshal.SizeOf(i);',
  '    if (!GetLastInputInfo(ref i)) return 0;',
  '    return (uint)Environment.TickCount - i.dwTime;',
  '  }',
  '}',
].join('\n')

function buildScript(windowMs) {
  return [
    '$ErrorActionPreference = "Stop"',
    `Add-Type -TypeDefinition @'\n${TYPE_DEFINITION}\n'@`,
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${windowMs})`,
    '$pt = New-Object WebotDesk+POINT',
    '$prevX = 0; $prevY = 0; $first = $true; $total = 0.0; $keys = 0',
    'while ([DateTime]::UtcNow -lt $deadline) {',
    `  Start-Sleep -Milliseconds ${SAMPLE_MS}`,
    '  [void][WebotDesk]::GetCursorPos([ref]$pt)',
    '  if ($first) { $prevX = $pt.X; $prevY = $pt.Y; $first = $false }',
    '  else {',
    '    $dx = $pt.X - $prevX; $dy = $pt.Y - $prevY',
    '    $total += [math]::Sqrt($dx * $dx + $dy * $dy)',
    '    $prevX = $pt.X; $prevY = $pt.Y',
    '  }',
    `  if ([WebotDesk]::IdleMs() -lt ${KEYBOARD_IDLE_MS}) { $keys += 1 }`,
    '}',
    'Write-Output ("{0} {1}" -f [int]$total, $keys)',
  ].join('\n')
}

/**
 * Sample the desk for `windowMs` and resolve with what happened.
 *
 * Resolves `null` when the probe cannot run at all (not Windows, no PowerShell,
 * policy block) — the caller decides what an unknown answer means.
 */
export function watchDesk(windowMs) {
  if (process.platform !== 'win32') return Promise.resolve(null)

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          buildScript(Math.max(1000, Math.round(windowMs))),
        ],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      resolve(null)
      return
    }

    let out = ''
    child.stdout.on('data', (chunk) => {
      out += String(chunk)
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const [travel, keys] = String(out).trim().split(/\s+/).map(Number)
      if (!Number.isFinite(travel)) {
        resolve(null)
        return
      }
      resolve({
        travelPx: travel,
        keyboardSamples: Number.isFinite(keys) ? keys : 0,
        thresholdPx: DEFAULT_TRAVEL_PX,
      })
    })
  })
}

/** Did this window look like somebody sitting at the desk? */
export function atTheDesk(report) {
  if (!report) return false
  return report.travelPx >= report.thresholdPx || report.keyboardSamples >= KEYBOARD_SAMPLES
}
